import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { racePromiseWithAbortSignal, raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

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

  try {
    const result =
      options.timeoutMs === undefined
        ? await racePromiseWithAbortSignal(promise, options.abortSignal, () => RACE_ABORT)
        : await raceWithTimeout<T, typeof RACE_TIMEOUT | typeof RACE_ABORT>(
            promise,
            resolveTimerTimeoutMs(options.timeoutMs, 1),
            () => RACE_TIMEOUT,
            { signal: options.abortSignal, onAbort: () => RACE_ABORT },
          );
    if (result === RACE_TIMEOUT) {
      return { status: "timeout" };
    }
    if (result === RACE_ABORT) {
      return { status: "aborted" };
    }
    return { status: "resolved", value: result };
  } catch (error) {
    if (error === RACE_ABORT) {
      return { status: "aborted" };
    }
    throw error;
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
