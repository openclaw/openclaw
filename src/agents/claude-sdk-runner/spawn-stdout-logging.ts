import { spawn } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_SDK_STDOUT_TAIL_MAX_CHARS = 4096;
export const CLAUDE_SDK_STDERR_TAIL_MAX_CHARS = 4096;

export type ClaudeSdkSpawnProcess = (options: SpawnOptions) => SpawnedProcess;

type CreateSpawnWithStdoutTailLoggingOptions = {
  baseSpawn?: ClaudeSdkSpawnProcess;
  maxTailChars?: number;
  onExitCodeOne?: (stdoutTail: string) => void;
};

function appendStdoutTail(currentTail: string, chunk: string, maxTailChars: number): string {
  if (!chunk) {
    return currentTail;
  }
  const next = `${currentTail}${chunk}`;
  if (next.length <= maxTailChars) {
    return next;
  }
  return next.slice(-maxTailChars);
}

export function defaultClaudeSdkSpawnProcess(options: SpawnOptions): SpawnedProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function createClaudeSdkSpawnWithStdoutTailLogging(
  options?: CreateSpawnWithStdoutTailLoggingOptions,
): ClaudeSdkSpawnProcess {
  const baseSpawn = options?.baseSpawn ?? defaultClaudeSdkSpawnProcess;
  const maxTailChars = Math.max(1, options?.maxTailChars ?? CLAUDE_SDK_STDOUT_TAIL_MAX_CHARS);

  return (spawnOptions: SpawnOptions): SpawnedProcess => {
    const process = baseSpawn(spawnOptions);
    let stdoutTail = "";

    process.stdout.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutTail = appendStdoutTail(stdoutTail, text, maxTailChars);
    });

    process.once("exit", (code: number | null) => {
      if (code === 1) {
        options?.onExitCodeOne?.(stdoutTail);
      }
    });

    return process;
  };
}
