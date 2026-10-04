import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

const RACE_TIMEOUT = Symbol("race-timeout");
const RACE_ABORT = Symbol("race-abort");

type RaceWithTimeoutAndAbortResult<T> =
  | { status: "resolved"; value: T }
  | { status: "timeout" }
  | { status: "aborted" };

export async function raceWithTimeoutAndAbort<T>(
  promise: Promise<T>,
  options: {
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  } = {},
): Promise<RaceWithTimeoutAndAbortResult<T>> {
  if (options.abortSignal?.aborted) {
    return { status: "aborted" };
  }

  if (options.timeoutMs === undefined && !options.abortSignal) {
    return { status: "resolved", value: await promise };
  }

  let abortHandler: (() => void) | undefined;
  const contenders: Array<Promise<T | typeof RACE_ABORT>> = [promise];

  if (options.abortSignal) {
    contenders.push(
      new Promise((resolve) => {
        abortHandler = () => resolve(RACE_ABORT);
        options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      }),
    );
  }

  try {
    const settled = Promise.race(contenders);
    const result =
      options.timeoutMs === undefined
        ? await settled
        : await raceWithTimeout(
            settled,
            resolveTimerTimeoutMs(options.timeoutMs, 1),
            (): typeof RACE_TIMEOUT => RACE_TIMEOUT,
          );
    if (result === RACE_TIMEOUT) {
      return { status: "timeout" };
    }
    if (result === RACE_ABORT) {
      return { status: "aborted" };
    }
    return { status: "resolved", value: result };
  } finally {
    if (abortHandler) {
      options.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }
}

export function waitForAbortableDelay(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (abortSignal?.aborted) {
    return Promise.resolve(false);
  }

  return sleepWithAbort(resolveTimerTimeoutMs(delayMs, 1), abortSignal, { ref: false }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") {
        return false;
      }
      throw error;
    },
  );
}
