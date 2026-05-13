import { isAgentBusyError } from "../../../infra/unhandled-rejections.js";

export const DEFAULT_AGENT_BUSY_RETRY_TIMEOUT_MS = 3_000;
const DEFAULT_AGENT_BUSY_RETRY_POLL_MS = 100;

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

function makeAbortError(signal: AbortSignal): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  error.cause = signal.reason;
  return error;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw makeAbortError(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(makeAbortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout.unref?.();
  });
}

async function waitUntilIdle(params: {
  isStreaming: () => boolean;
  signal?: AbortSignal;
  sleepFn: SleepFn;
  timeoutMs: number;
  pollMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + params.timeoutMs;
  while (params.isStreaming()) {
    if (params.signal?.aborted) {
      throw makeAbortError(params.signal);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await params.sleepFn(Math.min(params.pollMs, remaining), params.signal);
  }
  return true;
}

export async function runWithAgentBusyRetry<T>(params: {
  operation: () => Promise<T>;
  isStreaming: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  sleepFn?: SleepFn;
}): Promise<T> {
  try {
    return await params.operation();
  } catch (err) {
    if (!isAgentBusyError(err)) {
      throw err;
    }

    const becameIdle = await waitUntilIdle({
      isStreaming: params.isStreaming,
      signal: params.signal,
      sleepFn: params.sleepFn ?? sleep,
      timeoutMs: params.timeoutMs ?? DEFAULT_AGENT_BUSY_RETRY_TIMEOUT_MS,
      pollMs: params.pollMs ?? DEFAULT_AGENT_BUSY_RETRY_POLL_MS,
    });
    if (!becameIdle) {
      throw err;
    }

    return await params.operation();
  }
}
