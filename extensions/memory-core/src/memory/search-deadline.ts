import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_MEMORY_SEARCH_TIMEOUT_MS = 15_000;
export function resolveMemorySearchAbortError(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "memory search aborted");
}

// The deadline owner is the only place that knows a failure is this tool's own
// timeout: a provider is free to emit the same text, and the catch path has
// flattened both to a string before recovery guidance is chosen. Membership is
// by object identity, never by a property, because the supervised task receives
// this error as `signal.reason` and could copy any marker on it onto a failure
// of its own.
const memorySearchDeadlineErrors = new WeakSet<object>();

type MemorySearchDeadlineScope = {
  suspend: <T>(run: () => Promise<T>) => Promise<T>;
};

// Search managers are shared across concurrent requests. Async context keeps each
// request's pausable budget attached to its own provider-acquisition chain.
const memorySearchDeadlineScope = new AsyncLocalStorage<MemorySearchDeadlineScope>();
const memorySearchDeadlineChecks = new WeakMap<AbortSignal, () => void>();

export async function runWithMemorySearchDeadlineSuspended<T>(run: () => Promise<T>): Promise<T> {
  const scope = memorySearchDeadlineScope.getStore();
  return scope ? await scope.suspend(run) : await run();
}

export function createMemorySearchDeadlineError(message: string): Error {
  const error = new Error(message);
  memorySearchDeadlineErrors.add(error);
  return error;
}

function createMemorySearchTimeoutError(timeoutMs: number): Error {
  return createMemorySearchDeadlineError(
    `memory_search timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

export function checkMemorySearchDeadline(signal: AbortSignal): void {
  memorySearchDeadlineChecks.get(signal)?.();
}

export function isMemorySearchDeadlineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && memorySearchDeadlineErrors.has(error);
}

export async function runMemoryOperationWithDeadline<T>(params: {
  timeoutError: Error;
  timeoutMs: number;
  now?: () => number;
  parentSignal?: AbortSignal;
  suspendable?: boolean;
  settleAfterTimeout?: boolean;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (params.parentSignal?.aborted) {
    throw resolveMemorySearchAbortError(params.parentSignal);
  }

  const controller = new AbortController();
  const timeoutError = params.timeoutError;
  const timeoutOutcome = { type: "timeout" } as const;
  const parentAbortOutcome = { type: "parent-abort" } as const;
  const now = params.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeBudgetStartedAt = now();
  let remainingMs = params.timeoutMs;
  let suspendDepth = 0;
  let deadlineReached = false;
  let removeParentAbort: (() => void) | undefined;
  let resolveTimeout!: (outcome: typeof timeoutOutcome) => void;
  const timeoutPromise = new Promise<typeof timeoutOutcome>((resolve) => {
    resolveTimeout = resolve;
  });
  const reachDefaultDeadline = () => {
    if (deadlineReached) {
      return;
    }
    deadlineReached = true;
    // Resolve before aborting so abort-aware tasks cannot replace the stable
    // deadline error with a provider-wrapped cancellation error.
    resolveTimeout(timeoutOutcome);
    controller.abort(timeoutError);
  };
  const startTimer = () => {
    if (controller.signal.aborted || deadlineReached) {
      return;
    }
    if (remainingMs <= 0) {
      reachDefaultDeadline();
      return;
    }
    activeBudgetStartedAt = now();
    timer = setTimeout(() => {
      timer = undefined;
      remainingMs = 0;
      reachDefaultDeadline();
    }, remainingMs);
    timer.unref?.();
  };
  const pauseTimer = () => {
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    remainingMs = Math.max(0, remainingMs - (now() - activeBudgetStartedAt));
    if (remainingMs <= 0) {
      reachDefaultDeadline();
    }
  };
  const checkDeadline = () => {
    // A synchronous operation can finish before an overdue timer is serviced.
    if (
      timer !== undefined &&
      !controller.signal.aborted &&
      now() - activeBudgetStartedAt >= remainingMs
    ) {
      clearTimeout(timer);
      timer = undefined;
      remainingMs = 0;
      reachDefaultDeadline();
    }
  };
  const scope: MemorySearchDeadlineScope = {
    suspend: async <R>(run: () => Promise<R>): Promise<R> => {
      if (suspendDepth === 0) {
        pauseTimer();
      }
      suspendDepth += 1;
      try {
        return await run();
      } finally {
        suspendDepth -= 1;
        if (suspendDepth === 0) {
          startTimer();
        }
      }
    },
  };
  memorySearchDeadlineChecks.set(controller.signal, checkDeadline);
  startTimer();
  const parentSignal = params.parentSignal;
  const parentAbortPromise = parentSignal
    ? new Promise<typeof parentAbortOutcome>((resolve) => {
        const onAbort = () => {
          resolve(parentAbortOutcome);
          controller.abort(resolveMemorySearchAbortError(parentSignal));
        };
        parentSignal.addEventListener("abort", onAbort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
      })
    : undefined;
  const startTask = () => Promise.resolve().then(() => params.run(controller.signal));
  const task = params.suspendable ? memorySearchDeadlineScope.run(scope, startTask) : startTask();
  task.catch(() => undefined);

  try {
    const outcomes: Array<Promise<T | typeof timeoutOutcome | typeof parentAbortOutcome>> = [task];
    if (!params.settleAfterTimeout) {
      outcomes.push(timeoutPromise);
    }
    if (parentAbortPromise) {
      outcomes.push(parentAbortPromise);
    }
    const result = await Promise.race(outcomes);
    if (result === parentAbortOutcome) {
      throw resolveMemorySearchAbortError(parentSignal!);
    }
    if (result === timeoutOutcome) {
      throw timeoutError;
    }
    if (parentSignal?.aborted) {
      throw resolveMemorySearchAbortError(parentSignal);
    }
    const alreadyAborted = controller.signal.aborted;
    checkDeadline();
    if (!alreadyAborted && controller.signal.aborted) {
      throw timeoutError;
    }
    return result as T;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    memorySearchDeadlineChecks.delete(controller.signal);
    removeParentAbort?.();
  }
}

export async function runMemorySearchWithDeadline<T>(params: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  return await runMemoryOperationWithDeadline({
    ...params,
    timeoutError: createMemorySearchTimeoutError(params.timeoutMs),
    suspendable: true,
  });
}
