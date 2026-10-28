import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clampTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { monotonicNow, racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";

const requestBudget = new AsyncLocalStorage<{ pause: () => () => void }>();

/** Startup is shared service work; only the requesting wait belongs to this deadline. */
export async function waitForBrowserStartup<T>(work: () => Promise<T>): Promise<T> {
  const resume = requestBudget.getStore()?.pause();
  try {
    return await work();
  } finally {
    resume?.();
  }
}

export async function withTimeout<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  label?: string,
  upstreamSignal?: AbortSignal | null,
): Promise<T> {
  upstreamSignal?.throwIfAborted();
  const parentBudget = requestBudget.getStore();
  const resolved = clampTimerTimeoutMs(timeoutMs);
  if (!resolved) {
    return await work(upstreamSignal ?? undefined);
  }

  const controller = new AbortController();
  const error = new Error(`${label ?? "request"} timed out`);
  const timeout = createDeferred<never>();
  let remaining = resolved;
  let startedAt = monotonicNow();
  let paused = 0;
  let finished = false;
  const expire = () => {
    // Timeout wins even when work resolves from its abort listener.
    timeout.reject(error);
    controller.abort(error);
  };
  const arm = () => {
    startedAt = monotonicNow();
    const timer = setTimeout(expire, remaining);
    timer.unref?.();
    return timer;
  };
  let timer = arm();
  const signal = upstreamSignal
    ? AbortSignal.any([controller.signal, upstreamSignal])
    : controller.signal;

  try {
    return await requestBudget.run(
      {
        pause: () => {
          const resumeParent = parentBudget?.pause();
          if (paused++ === 0) {
            clearTimeout(timer);
            remaining = Math.max(1, remaining - (monotonicNow() - startedAt));
          }
          return () => {
            if (--paused === 0 && !finished) {
              timer = arm();
            }
            resumeParent?.();
          };
        },
      },
      () =>
        racePromiseWithAbortSignal(
          Promise.race([work(signal), timeout.promise]),
          upstreamSignal ?? undefined,
          ({ reason }) => toErrorObject(reason ?? new Error("aborted"), "Non-Error rejection"),
        ),
    );
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}
