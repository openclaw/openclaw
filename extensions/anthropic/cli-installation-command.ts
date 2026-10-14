import fs from "node:fs/promises";
import path from "node:path";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-constants.js";
import type { ClaudeCommandContext } from "./cli-installation.types.js";
import { parseClaudeCodeVersion } from "./cli-shared.js";

export const CLAUDE_CODE_PACKAGE_NAME = "@anthropic-ai/claude-code";
const PROBE_TIMEOUT_MS = 5_000;
const UPDATE_TIMEOUT_MS = 15 * 60_000;

export function assertCurrent(context: ClaudeCommandContext) {
  context.signal?.throwIfAborted();
  context.assertCurrent();
}

export function homeDirectory(context: ClaudeCommandContext): string | undefined {
  const home = context.env.HOME ?? context.env.USERPROFILE;
  return home && path.isAbsolute(home) ? home : undefined;
}

export async function executableExists(command: string): Promise<boolean> {
  try {
    if (!(await fs.stat(command)).isFile()) {
      return false;
    }
    await fs.access(command, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function commandResolutionProblem(
  context: ClaudeCommandContext,
  command = context.command,
): string | undefined {
  const traversesParent = (value: string) => value.split(/[\\/]/u).includes("..");
  if (traversesParent(command) || (context.cwd && traversesParent(context.cwd))) {
    return "Claude maintenance requires a command and working directory without parent traversal. Configure their absolute paths.";
  }
  if (!command.includes("/") && !command.includes("\\")) {
    const directories = (context.env.PATH ?? context.env.Path ?? "").split(path.delimiter);
    if (
      directories.some((directory) => !path.isAbsolute(directory) || traversesParent(directory))
    ) {
      return "Claude maintenance cannot resolve a bare command through relative, empty, or parent-traversing PATH entries. Configure its absolute launcher path.";
    }
  }
  return undefined;
}

// Maintenance must observe launcher changes immediately, without the ordinary PATH cache.
export async function resolveCommand(
  context: ClaudeCommandContext,
  command = context.command,
): Promise<string | undefined> {
  if (commandResolutionProblem(context, command)) {
    return undefined;
  }
  let selected = command;
  if (selected.startsWith("~/")) {
    const home = homeDirectory(context);
    if (!home) {
      return undefined;
    }
    selected = path.join(home, selected.slice(2));
  }
  if (selected.includes("/") || selected.includes("\\")) {
    if (!path.isAbsolute(selected)) {
      if (!context.cwd || !path.isAbsolute(context.cwd)) {
        return undefined;
      }
      selected = path.resolve(context.cwd, selected);
    }
    return (await executableExists(selected)) ? selected : undefined;
  }
  if (process.platform === "win32") {
    const resolved = resolveWindowsExecutablePath(
      selected,
      { ...context.env, PATH: context.env.PATH ?? context.env.Path ?? "" },
      context.cwd,
    );
    return path.isAbsolute(resolved) && (await executableExists(resolved)) ? resolved : undefined;
  }
  for (const directory of (context.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, selected);
    if (await executableExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function runCommand(
  context: ClaudeCommandContext,
  command: string,
  args: readonly string[],
  update = false,
) {
  const env = { ...context.env };
  for (const name of CLAUDE_CLI_CLEAR_ENV) {
    delete env[name];
  }
  const program = resolveWindowsSpawnProgram({
    command,
    env,
    packageName: path.basename(command).startsWith("npm") ? "npm" : CLAUDE_CODE_PACKAGE_NAME,
  });
  const invocation = materializeWindowsSpawnProgram(program, [...args]);
  assertCurrent(context);
  return runUtf8CommandWithTimeout([invocation.command, ...invocation.argv], {
    baseEnv: env,
    cwd: homeDirectory(context),
    signal: context.signal,
    timeoutMs: update ? UPDATE_TIMEOUT_MS : PROBE_TIMEOUT_MS,
    maxOutputBytes: update ? 64 * 1024 : 8 * 1024,
    maxCombinedOutputBytes: update ? 128 * 1024 : 16 * 1024,
    terminateOnOutputLimit: true,
    killProcessTree: true,
  });
}

export function commandSucceeded(result: Awaited<ReturnType<typeof runCommand>>): boolean {
  return result.termination === "exit" && result.code === 0 && !result.outputLimitExceeded;
}

/** Probe the configured launcher afresh without falling back to another installation. */
export async function probeClaudeVersion(
  context: ClaudeCommandContext,
): Promise<string | undefined> {
  assertCurrent(context);
  const command = await resolveCommand(context);
  if (!command) {
    return undefined;
  }
  const result = await runCommand(context, command, ["--version"]);
  assertCurrent(context);
  return commandSucceeded(result) ? parseClaudeCodeVersion(result.stdout) : undefined;
}
