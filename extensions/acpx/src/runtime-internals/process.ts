import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "openclaw/plugin-sdk";
import {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "openclaw/plugin-sdk";

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

  return spawn(resolved.command, resolved.args, {
    cwd: params.cwd,
    env: { ...process.env, OPENCLAW_SHELL: "acp" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  });
}

export async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<SpawnExit> {
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
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  error: Error | null;
}> {
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

  const exit = await waitForExit(child);
  return {
    stdout,
    stderr,
    code: exit.code,
    error: exit.error,
  };
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
