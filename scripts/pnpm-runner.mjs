import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

/**
 * Checks if the filename looks like pnpm.
 */
function isPnpmExecPath(value) {
  return /^pnpm(?:-cli)?(?:\.(?:c?js|cmd|exe))?$/.test(path.basename(value).toLowerCase());
}

/**
 * Checks if the file path has a JavaScript-related extension.
 */
function isJavaScriptFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.js' || ext === '.cjs' || ext === '.mjs';
}

export function resolvePnpmRunner(params = {}) {
  const pnpmArgs = params.pnpmArgs ?? [];
  const nodeArgs = params.nodeArgs ?? [];
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? process.env.ComSpec ?? "cmd.exe";

  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isPnpmExecPath(npmExecPath)) {
    // If it's a JS file, we must run it through Node.
    if (isJavaScriptFile(npmExecPath)) {
      return {
        command: nodeExecPath,
        args: [...nodeArgs, npmExecPath, ...pnpmArgs],
        shell: false,
      };
    } else {
      // If it's a native binary (ELF on Linux/Pi or EXE on Windows), 
      // run the path directly without prepending 'node'.
      return {
        command: npmExecPath,
        args: pnpmArgs,
        shell: false,
      };
    }
  }

  // Windows fallback logic
  if (platform === "win32") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine("pnpm.cmd", pnpmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  // General fallback logic
  return {
    command: "pnpm",
    args: pnpmArgs,
    shell: false,
  };
}

export function createPnpmRunnerSpawnSpec(params = {}) {
  const runner = resolvePnpmRunner(params);
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd: params.cwd,
      detached: params.detached,
      stdio: params.stdio ?? "inherit",
      env: params.env ?? runner.env ?? process.env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

export function spawnPnpmRunner(params = {}) {
  const spawnSpec = createPnpmRunnerSpawnSpec(params);
  return spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
}