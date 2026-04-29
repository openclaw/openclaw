import { spawn } from "node:child_process";
import { decodeWindowsOutputBuffer } from "./windows-output-decoder.js";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram } from "./windows-spawn.js";

export type CliSpawnInvocation = {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
};

export type QmdBinaryAvailability = {
  available: boolean;
  error?: string;
};

export function resolveCliSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  packageName: string;
}): CliSpawnInvocation {
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: process.platform,
    env: params.env,
    execPath: process.execPath,
    packageName: params.packageName,
    allowShellFallback: false,
  });
  return materializeWindowsSpawnProgram(program, params.args);
}

export async function checkQmdBinaryAvailability(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<QmdBinaryAvailability> {
  let spawnInvocation: CliSpawnInvocation;
  try {
    spawnInvocation = resolveCliSpawnInvocation({
      command: params.command,
      args: [],
      env: params.env,
      packageName: "qmd",
    });
  } catch (err) {
    return { available: false, error: formatQmdAvailabilityError(err) };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let didSpawn = false;
    const finish = (result: QmdBinaryAvailability) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const child = spawn(spawnInvocation.command, spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd ?? process.cwd(),
      shell: spawnInvocation.shell,
      windowsHide: spawnInvocation.windowsHide,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        available: false,
        error: `spawn ${params.command} timed out after ${params.timeoutMs ?? 2_000}ms`,
      });
    }, params.timeoutMs ?? 2_000);

    child.once("error", (err) => {
      finish({ available: false, error: formatQmdAvailabilityError(err) });
    });
    child.once("spawn", () => {
      didSpawn = true;
      child.kill();
      finish({ available: true });
    });
    child.once("close", () => {
      if (!didSpawn) {
        return;
      }
      finish({ available: true });
    });
  });
}

export async function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd,
      shell: params.spawnInvocation.shell,
      windowsHide: params.spawnInvocation.windowsHide,
    });
    let stdoutBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const discardStdout = params.discardStdout === true;
    const timer = params.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs)
      : null;
    child.stdout.on("data", (data) => {
      if (discardStdout) {
        return;
      }
      const next = appendBufferWithByteCap(stdoutBuffer, data, params.maxOutputChars);
      stdoutBuffer = next.buffer;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (data) => {
      const next = appendBufferWithByteCap(stderrBuffer, data, params.maxOutputChars);
      stderrBuffer = next.buffer;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (!discardStdout) {
        const next = appendOutputWithCap(
          "",
          decodeWindowsOutputBuffer({ buffer: stdoutBuffer }),
          params.maxOutputChars,
        );
        stdout = next.text;
        stdoutTruncated = stdoutTruncated || next.truncated;
      }
      const nextStderr = appendOutputWithCap(
        "",
        decodeWindowsOutputBuffer({ buffer: stderrBuffer }),
        params.maxOutputChars,
      );
      stderr = nextStderr.text;
      stderrTruncated = stderrTruncated || nextStderr.truncated;
      if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
        reject(
          new Error(
            `${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`));
      }
    });
  });
}

function appendBufferWithByteCap(
  current: Buffer,
  chunk: Buffer | string | Uint8Array,
  maxChars: number,
): { buffer: Buffer; truncated: boolean } {
  const appended = Buffer.concat([current, outputChunkToBuffer(chunk)]);
  const maxBytes = maxBytesForCharCap(maxChars);
  if (appended.length <= maxBytes) {
    return { buffer: appended, truncated: false };
  }
  return { buffer: appended.subarray(appended.length - maxBytes), truncated: true };
}

function outputChunkToBuffer(chunk: Buffer | string | Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(chunk);
}

function maxBytesForCharCap(maxChars: number): number {
  return Math.max(0, Math.floor(maxChars)) * 4 + 8;
}

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  return { text: appended.slice(-maxChars), truncated: true };
}

function formatQmdAvailabilityError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}
