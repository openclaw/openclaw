import { spawn } from "node:child_process";

export type JsonObject = Record<string, unknown>;

type FetchJsonParams = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  init: RequestInit;
  label: string;
  timeoutMs: number;
  url: string;
};

type RunCommandOptions = {
  outputLimit?: number;
  timeoutKillGraceMs?: number;
  timeoutMs: number;
};

const DEFAULT_OUTPUT_LIMIT = 128 * 1024;
const KILL_GRACE_MS = 5_000;

function timeoutError(message: string) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

function appendBounded(previous: string, chunk: Buffer, limit: number) {
  const next = previous + chunk.toString();
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  options: RunCommandOptions,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout;
    let killTimer: NodeJS.Timeout | undefined;
    let timedOutError: Error | undefined;
    const timeoutMs = Math.max(1, options.timeoutMs);
    const timeoutKillGraceMs = Math.max(0, options.timeoutKillGraceMs ?? KILL_GRACE_MS);
    const clearTimers = () => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error);
    };
    timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOutError = timeoutError(
        `${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stdout}${stderr}`,
      );
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutKillGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, outputLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, outputLimit);
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (timedOutError) {
        reject(timedOutError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}\n${stdout}${stderr}`));
    });
  });
}

export async function fetchJsonWithTimeout(params: FetchJsonParams) {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const controller = new AbortController();
  const error = timeoutError(`${params.label} timed out after ${timeoutMs}ms`);
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const response = await Promise.race([
      (params.fetchImpl ?? fetch)(params.url, {
        ...params.init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    const payload = (await Promise.race([response.json(), timeoutPromise])) as JsonObject;
    return { payload, response };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
