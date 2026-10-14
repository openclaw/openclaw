// Resolves npm commands without Windows shell lookup or a Node dependency under Bun.
import fs from "node:fs";
import path from "node:path";
import { resolveBundledNpmCommand } from "../src/infra/npm-command.ts";
import {
  buildCmdExeCommandLine,
  resolvePathEnvKey,
  resolveWindowsCmdExePath,
} from "./windows-cmd-helpers.mjs";

export type NpmRunnerParams = {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (filePath: string) => boolean;
  npmArgs?: string[];
  platform?: NodeJS.Platform;
};

type NpmRunner = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  packageJsonPath?: string;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};

/** Resolves bundled npm under Bun, or npm from the selected Node toolchain. */
export function resolveNpmRunner(params: NpmRunnerParams = {}): NpmRunner {
  const execPath = params.execPath ?? process.execPath;
  const npmArgs = params.npmArgs ?? [];
  const existsSync = params.existsSync ?? fs.existsSync;
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? (platform === "win32" ? resolveWindowsCmdExePath(env) : "");
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(execPath);
  if (execPath === process.execPath && process.versions.bun) {
    const [command, npmCliPath, ...args] = resolveBundledNpmCommand(npmArgs);
    return {
      command,
      args: [npmCliPath, ...args],
      packageJsonPath: path.resolve(npmCliPath, "../../package.json"),
      shell: false,
    };
  }
  const npmCliCandidates = [
    pathImpl.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    pathImpl.resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (npmCliPath) {
    return {
      command: execPath,
      args: [npmCliPath, ...npmArgs],
      packageJsonPath: pathImpl.resolve(npmCliPath, "../../package.json"),
      shell: false,
    };
  }
  if (platform === "win32") {
    const npmExePath = pathImpl.resolve(nodeDir, "npm.exe");
    if (existsSync(npmExePath)) {
      return { command: npmExePath, args: npmArgs, shell: false };
    }
    const npmCmdPath = pathImpl.resolve(nodeDir, "npm.cmd");
    if (existsSync(npmCmdPath)) {
      return {
        command: comSpec,
        args: ["/d", "/s", "/c", buildCmdExeCommandLine(npmCmdPath, npmArgs)],
        shell: false,
        windowsVerbatimArguments: true,
      };
    }
    const expectedPaths = [...npmCliCandidates, npmExePath, npmCmdPath];
    throw new Error(
      `failed to resolve a toolchain-local npm next to ${execPath}. ` +
        `Checked: ${expectedPaths.join(", ")}. ` +
        "OpenClaw refuses to shell out to bare npm on Windows; install a Node.js toolchain that bundles npm or run with a matching Node installation.",
    );
  }
  const pathKey = resolvePathEnvKey(env);
  const currentPath = env[pathKey];
  return {
    command: "npm",
    args: npmArgs,
    shell: false,
    env: {
      ...env,
      [pathKey]:
        typeof currentPath === "string" && currentPath.length > 0
          ? `${nodeDir}${path.delimiter}${currentPath}`
          : nodeDir,
    },
  };
}
