#!/usr/bin/env node
'use strict';

const chalk = require('chalk');
const spawn = require('cross-spawn');
const fs = require('fs');
const path = require('path');
const exec = require('child_process').exec;
const chokidar = require('chokidar');

const compilationStartedRegex = /Starting incremental compilation/;
const compilationCompleteRegex = / Compilation complete\. Watching for file changes\./;
const typescriptSuccessRegex = /Compilation complete/;
const typescriptWatchCommandRegex = /Watch input files\./;
const typescriptErrorRegex = /\(\d+,\d+\): error TS\d+:/;
const onSuccessCommandSyntax = ' --onSuccess COMMAND                                Run the COMMAND on each successful compilation';
const onFirstSuccessCommandSyntax = ' --onFirstSuccess COMMAND                           Run the COMMAND on the first successful compilation (Will not run the onSuccess)';
const newAdditionToSyntax = ['Watch input files. [always on]', onSuccessCommandSyntax, onFirstSuccessCommandSyntax].join('\n');

let hadErrors = false;
let firstTime = true;
let firstSuccessProcess = null;
let successProcess = null;

function color(line) {
  if (typescriptErrorRegex.test(line)) {
    return chalk.red(line);
  }

  if (typescriptSuccessRegex.test(line) || typescriptWatchCommandRegex.test(line)) {
    return chalk.green(line);
  }

  return chalk.white(line);
}

function print(lines) {
  return lines.forEach(line => console.log(color(line)));
}

function cleanArgs(inputArgs) {
  return inputArgs
    .splice(2)
    .filter(arg => arg.toLowerCase() !== '-w')
    .filter(arg => arg.toLowerCase() !== '--watch')
    .filter(arg => arg.toLowerCase() !== '--onsuccess')
    .filter(arg => arg.toLowerCase() !== '--onfirstsuccess');
}

function getCommandIdx(inputArgs, command) {
  const idx = inputArgs.indexOf(command);
  if (idx > -1 && idx + 1 < inputArgs.length) {
    return idx;
  } else {
    return -1;
  }
}

function runCommand(fullCommand) {
  const parts = fullCommand.split(' ').filter(a => a.length > 0);
  return spawn(parts[0], parts.slice(1), {stdio: 'inherit'})
}

function killAllProcesses() {
  if (firstSuccessProcess) {
    firstSuccessProcess.kill();
    firstSuccessProcess = null;
  }

  if (successProcess) {
    successProcess.kill();
    successProcess = null;
  }
}

function getArg(argName, allArgs, isTscParam = true)
{
    let Idx = getCommandIdx(allArgs, argName);
    let arg = null;
    if (Idx > -1) {
        arg = allArgs[Idx + 1];
        if (!isTscParam)
            allArgs.splice(Idx, 2)
    }
    return arg;
}

function getProjectDir() {
  return getArg('--project', allArgs) || getArg('-p', allArgs) || process.cwd();
}

function readTsConfig(tsconfig)
{
    let lsstat = fs.lstatSync(tsconfig);
    if (lsstat.isDirectory())
    {
        let trimmed = tsconfig.slice(-1) == '/' ? tsconfig.slice(0,-1) : tsconfig; //  trim tail '/'
        tsconfig = trimmed + '/tsconfig.json';
    }
    return eval('(' + fs.readFileSync(tsconfig, 'utf8') + ')');  //eval allows c-style comment in tsconfig.json
}

function getIncludeFromTsConfig(config)
{
    let include = [];
    if (config.files)
        include = include.concat(config.files);
    if (config.include)
        include = include.concat(config.include);
    return include;
}
function getExcludeFromTsConfig(config)
{
    let exclude = [];
    if (config.exclude)
        exclude = config.exclude;
    return exclude;
}
function getRootDirFromTsConfig(config)
{
    let rootDir = null;
    if (config.compilerOptions && config.compilerOptions.rootDir)
        rootDir = config.compilerOptions.rootDir;
    return rootDir;
}
function getOutDirFromTsConfig(config)
{
    let outDir = null;
    if (config.compilerOptions && config.compilerOptions.outDir)
        outDir = config.compilerOptions.outDir;
    return outDir;
}

function watchForDelete(rootDir, outDir, include, exclude) {
    let resolveDest = (file) => path.resolve(outDir, path.relative(rootDir, file));

    chokidar.watch(include, {ignored: exclude})
        .on('unlink', filePath => {
            filePath = resolveDest(filePath).slice(0, -2) + 'js';
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, (err) => {
                    console.log('Cannot remove ' + filePath + ' : ' + err);
                });
            }
        })
        .on('unlinkDir', dirPath => {
            dirPath = resolveDest( path.relative(getProjectDir(), dirPath) );
            let child = exec('rm -rf ' + dirPath);
            child.addListener('exit', () => {exec('rmdir -rf ' + dirPath)});
        })
        .on('error', err => {
            console.log('Error watching for deleted/renamed/moved file ' + err);
        });
}

//////////////////////////////////////

let allArgs = process.argv;
// onSuccess

let onSuccessCommand= getArg('--onSuccess', allArgs, false);
let onFirstSuccessCommand = getArg('--onFirstSuccess', allArgs, false);
let rootDir = getArg('--rootDir', allArgs);
let outDir = getArg('--outDir', allArgs);

allArgs = cleanArgs(allArgs);
allArgs.push('--watch'); // force watch

const bin = require.resolve('typescript/bin/tsc');
const tscProcess = spawn(bin, [...allArgs]);

let projectDir = getProjectDir();
let include, exclude;
try {
    let tsconfig = readTsConfig(projectDir);
    include = getIncludeFromTsConfig(tsconfig);
    exclude = getExcludeFromTsConfig(tsconfig);
    if (!rootDir)
        rootDir = getRootDirFromTsConfig(tsconfig);
    if (!outDir)
        outDir = getOutDirFromTsConfig(tsconfig);
} catch(err){
    console.log('Warning: cannot locate tsconfig.json in ' + projectDir + ' OR tsconfig.json is not valid json.\n' + err);
}

if (include && rootDir && outDir)
    watchForDelete(rootDir, outDir, include, exclude);
else
    console.log('Autodelete is disabled: You have to specify "include" in tsconfig.json, either ["rootDir", "outDir" in tsconfig.json] or [arguments --rootDir, --outDir] in order to enable autodelete.');

tscProcess.stdout.on('data', buffer => {
  const lines = buffer.toString()
    .split('\n')
    .filter(a => a.length > 0)
    // .filter(a => a !== '\r')
    .map(a => a.replace(typescriptWatchCommandRegex, newAdditionToSyntax));

  print(lines);

  const newCompilation = lines.some(line => compilationStartedRegex.test(line));
  if (newCompilation) {
    hadErrors = false;
  }

  const error = lines.some(line => typescriptErrorRegex.test(line));
  if (error) {
    hadErrors = true;
  }

  const compilationComplete = lines.some(line => compilationCompleteRegex.test(line));
  if (compilationComplete) {
    if (hadErrors) {
      console.log('Had errors, not spawning');
    } else {
      killAllProcesses();
      if (firstTime && onFirstSuccessCommand) {
        firstTime = false;
        firstSuccessProcess = runCommand(onFirstSuccessCommand);
      } else {
        successProcess = runCommand(onSuccessCommand);
      }
    }
  }
});

tscProcess.on('exit', killAllProcesses);
