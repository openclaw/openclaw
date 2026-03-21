import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "../../runtime-api.js";
import {
  applyWindowsSpawnProgramPolicy,
  listKnownProviderAuthEnvVarNames,
  materializeWindowsSpawnProgram,
  omitEnvKeysCaseInsensitive,
  resolveWindowsSpawnProgramCandidate,
} from "../../runtime-api.js";

export type SpawnExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

type ResolvedSpawnCommand = {
  command: string;
  args: string[];
  shell?: boolean;
  windowsHide?: boolean;
};

type SpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

export type SpawnCommandCache = {
  key?: string;
  candidate?: WindowsSpawnProgramCandidate;
};

export type SpawnResolution = WindowsSpawnResolution | "unresolved-wrapper";
export type SpawnResolutionEvent = {
  command: string;
  cacheHit: boolean;
  strictWindowsCmdWrapper: boolean;
  resolution: SpawnResolution;
};

export type SpawnCommandOptions = {
  strictWindowsCmdWrapper?: boolean;
  cache?: SpawnCommandCache;
  onResolved?: (event: SpawnResolutionEvent) => void;
};

const DEFAULT_RUNTIME: SpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableFromPath(command: string, runtime: SpawnRuntime): string | undefined {
  const pathEnv = runtime.env.PATH ?? runtime.env.Path;
  if (!pathEnv) {
    return undefined;
  }
  for (const entry of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, command);
    if (isExecutableFile(candidate, runtime.platform)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveNodeShebangScriptPath(command: string, runtime: SpawnRuntime): string | undefined {
  const commandPath =
    path.isAbsolute(command) || command.includes(path.sep)
      ? command
      : resolveExecutableFromPath(command, runtime);
  if (!commandPath || !isExecutableFile(commandPath, runtime.platform)) {
    return undefined;
  }
  try {
    const firstLine = readFileSync(commandPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (/^#!.*(?:\/usr\/bin\/env\s+node\b|\/node(?:js)?\b)/.test(firstLine)) {
      return commandPath;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveSpawnCommand(
  params: { command: string; args: string[] },
  options?: SpawnCommandOptions,
  runtime: SpawnRuntime = DEFAULT_RUNTIME,
): ResolvedSpawnCommand {
  if (runtime.platform !== "win32") {
    const nodeShebangScript = resolveNodeShebangScriptPath(params.command, runtime);
    if (nodeShebangScript) {
      options?.onResolved?.({
        command: params.command,
        cacheHit: false,
        strictWindowsCmdWrapper: options?.strictWindowsCmdWrapper === true,
        resolution: "direct",
      });
      return {
        command: runtime.execPath,
        args: [nodeShebangScript, ...params.args],
      };
    }
  }

  const strictWindowsCmdWrapper = options?.strictWindowsCmdWrapper === true;
  const cacheKey = params.command;
  const cachedProgram = options?.cache;

  const cacheHit = cachedProgram?.key === cacheKey && cachedProgram.candidate != null;
  let candidate =
    cachedProgram?.key === cacheKey && cachedProgram.candidate
      ? cachedProgram.candidate
      : undefined;
  if (!candidate) {
    candidate = resolveWindowsSpawnProgramCandidate({
      command: params.command,
      platform: runtime.platform,
      env: runtime.env,
      execPath: runtime.execPath,
      packageName: "acpx",
    });
    if (cachedProgram) {
      cachedProgram.key = cacheKey;
      cachedProgram.candidate = candidate;
    }
  }

  let program: WindowsSpawnProgram;
  try {
    program = applyWindowsSpawnProgramPolicy({
      candidate,
      allowShellFallback: !strictWindowsCmdWrapper,
    });
  } catch (error) {
    options?.onResolved?.({
      command: params.command,
      cacheHit,
      strictWindowsCmdWrapper,
      resolution: candidate.resolution,
    });
    throw error;
  }

  const resolved = materializeWindowsSpawnProgram(program, params.args);
  options?.onResolved?.({
    command: params.command,
    cacheHit,
    strictWindowsCmdWrapper,
    resolution: resolved.resolution,
  });
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

function createAbortError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

export function spawnWithResolvedCommand(
  params: {
    command: string;
    args: string[];
    cwd: string;
    stripProviderAuthEnvVars?: boolean;
    detached?: boolean;
  },
  options?: SpawnCommandOptions,
): ChildProcessWithoutNullStreams {
  const resolved = resolveSpawnCommand(
    {
      command: params.command,
      args: params.args,
    },
    options,
  );

  const childEnv = omitEnvKeysCaseInsensitive(
    process.env,
    params.stripProviderAuthEnvVars ? listKnownProviderAuthEnvVarNames() : [],
  );
  childEnv.OPENCLAW_SHELL = "acp";

  return spawn(resolved.command, resolved.args, {
    cwd: params.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
    detached: params.detached ?? false,
  });
}

export async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<SpawnExit> {
  // Handle callers that start waiting after the child has already exited.
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
      error: null,
    };
  }

  return await new Promise<SpawnExit>((resolve) => {
    let settled = false;
    const finish = (result: SpawnExit) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    child.once("error", (err) => {
      finish({ code: null, signal: null, error: err });
    });

    child.once("close", (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}

/**
 * Kill a child process and its descendants.
 * Unix: kills the entire process group (requires spawning with detached: true).
 * Windows: kills only the direct child — orphaned grandchildren are a known limitation.
 * Uses SIGTERM → 250ms → SIGKILL escalation.
 */
export async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const useProcessGroup = process.platform !== "win32" && child.pid != null;
  const childAlreadyExited = child.exitCode !== null || child.signalCode !== null;

  // On Windows (no process groups), if child is already gone there's nothing to kill.
  if (!useProcessGroup && childAlreadyExited) {
    return;
  }

  const sendSignal = (signal: NodeJS.Signals) => {
    try {
      if (useProcessGroup) {
        process.kill(-child.pid!, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Already dead — ignore
    }
  };

  sendSignal("SIGTERM");

  // Child already closed — close event won't replay, no need to wait.
  // SIGTERM was still dispatched to the process group for any surviving grandchildren.
  if (childAlreadyExited) {
    return;
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sendSignal("SIGKILL");
      resolve();
    }, 250);
    timer.unref?.();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function spawnAndCollect(
  params: {
    command: string;
    args: string[];
    cwd: string;
    stripProviderAuthEnvVars?: boolean;
  },
  options?: SpawnCommandOptions,
  runtime?: {
    signal?: AbortSignal;
  },
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  error: Error | null;
}> {
  if (runtime?.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      code: null,
      error: createAbortError(),
    };
  }
  const child = spawnWithResolvedCommand(params, options);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let abortKillTimer: NodeJS.Timeout | undefined;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore kill races when child already exited.
    }
    abortKillTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill races when child already exited.
      }
    }, 250);
    abortKillTimer.unref?.();
  };
  runtime?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const exit = await waitForExit(child);
    return {
      stdout,
      stderr,
      code: exit.code,
      error: aborted ? createAbortError() : exit.error,
    };
  } finally {
    runtime?.signal?.removeEventListener("abort", onAbort);
    if (abortKillTimer) {
      clearTimeout(abortKillTimer);
    }
  }
}

export function resolveSpawnFailure(
  err: unknown,
  cwd: string,
): "missing-command" | "missing-cwd" | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    return null;
  }
  return directoryExists(cwd) ? "missing-command" : "missing-cwd";
}

function directoryExists(cwd: string): boolean {
  if (!cwd) {
    return false;
  }
  try {
    return existsSync(cwd);
  } catch {
    return false;
  }
}
