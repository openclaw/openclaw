import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "openclaw/plugin-sdk/acpx";
import {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "openclaw/plugin-sdk/acpx";

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

export function resolveSpawnCommand(
  params: { command: string; args: string[] },
  options?: SpawnCommandOptions,
  runtime: SpawnRuntime = DEFAULT_RUNTIME,
): ResolvedSpawnCommand {
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

  // Use detached on Unix so the child becomes a process group leader.
  // This allows killChildProcessTree() to terminate all descendants
  // when the session is closed or evicted, preventing zombie accumulation.
  const detached = process.platform !== "win32";
  return spawn(resolved.command, resolved.args, {
    cwd: params.cwd,
    env: { ...process.env, OPENCLAW_SHELL: "acp" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
    detached,
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

export async function spawnAndCollect(
  params: {
    command: string;
    args: string[];
    cwd: string;
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

const KILL_TREE_GRACE_MS = 3000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a child process and all its descendants.
 * Requires the child to have been spawned with `detached: true` (Unix)
 * so it is a process group leader.
 */
export function killChildProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    // taskkill /T kills the entire process tree on Windows.
    try {
      spawn("taskkill", ["/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!isProcessAlive(pid)) {
        return;
      }
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
      } catch {
        // ignore
      }
    }, KILL_TREE_GRACE_MS).unref();
    return;
  }

  // Unix: send SIGTERM to process group, then SIGKILL after grace period.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  setTimeout(() => {
    if (isProcessAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, KILL_TREE_GRACE_MS).unref();
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
