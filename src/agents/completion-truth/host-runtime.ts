import { selectCompletionTruth } from "./selector.js";
import type {
  CompletionTruthCandidates,
  CompletionWorkerOutput,
  ResolvedCompletionTruth,
} from "./types.js";

export interface HostYieldCollector {
  waitForNextYield(timeoutMs: number): Promise<string>;
}

export class YieldMessageQueue implements HostYieldCollector {
  private readonly pendingMessages: string[] = [];
  private readonly waiters: Array<{
    resolve: (message: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(message: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.pendingMessages.push(message);
  }

  waitForNextYield(timeoutMs: number): Promise<string> {
    const next = this.pendingMessages.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for yield after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }
}

export class WorkerOutputQueue<T = CompletionWorkerOutput> {
  private readonly pendingResults: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: T) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(result: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
      return;
    }
    this.pendingResults.push(result);
  }

  shift(): T | undefined {
    return this.pendingResults.shift();
  }

  waitForNextResult(timeoutMs: number): Promise<T> {
    const next = this.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for toolResult after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }
}

export interface CompletionTruthWaitPolicy {
  toolResultPriorityWindowMs: number;
}

export interface CompletionTruthPublicHostHook<T = CompletionWorkerOutput> {
  yieldQueue: YieldMessageQueue;
  toolResultQueue: WorkerOutputQueue<T>;
}

export function createCompletionTruthPublicHostHook<
  T = CompletionWorkerOutput,
>(): CompletionTruthPublicHostHook<T> {
  return {
    yieldQueue: new YieldMessageQueue(),
    toolResultQueue: new WorkerOutputQueue<T>(),
  };
}

export function createOnYieldForwarder(hook: CompletionTruthPublicHostHook) {
  return (message: string) => hook.yieldQueue.push(message);
}

export function createOnToolResultForwarder<T>(hook: CompletionTruthPublicHostHook<T>) {
  return (result: T) => hook.toolResultQueue.push(result);
}

function remainingTimeoutMs(params: { timeoutMs?: number; elapsedMs: number }): number | undefined {
  if (params.timeoutMs === undefined) {
    return undefined;
  }
  return Math.max(1, params.timeoutMs - params.elapsedMs);
}

export async function resolveCompletionTruthFromPublicHost<T = CompletionWorkerOutput>(params: {
  hook: CompletionTruthPublicHostHook<T>;
  parseRealtimeHint: (rawMessage: string) => T;
  timeoutMs?: number;
  waitPolicy?: Partial<CompletionTruthWaitPolicy>;
}): Promise<ResolvedCompletionTruth<T>> {
  const waitPolicy: CompletionTruthWaitPolicy = {
    toolResultPriorityWindowMs: 500,
    ...params.waitPolicy,
  };
  const startedAt = Date.now();
  const priorityWindowMs = Math.min(
    waitPolicy.toolResultPriorityWindowMs,
    params.timeoutMs ?? waitPolicy.toolResultPriorityWindowMs,
  );

  const candidates: CompletionTruthCandidates<T> = {};
  try {
    candidates.toolResult = await params.hook.toolResultQueue.waitForNextResult(priorityWindowMs);
  } catch {
    const fallbackTimeoutMs = remainingTimeoutMs({
      elapsedMs: Date.now() - startedAt,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    try {
      const rawHint = await params.hook.yieldQueue.waitForNextYield(fallbackTimeoutMs ?? 60_000);
      candidates.realtimeHint = params.parseRealtimeHint(rawHint);
    } catch {
      // Selector below owns explicit no-candidate failure.
    }
  }

  const resolution = selectCompletionTruth(candidates);
  if (resolution.result !== undefined) {
    return {
      output: resolution.result,
      selection: {
        source: resolution.source,
        confidence: resolution.confidence,
        ...(resolution.notes ? { notes: resolution.notes } : {}),
      },
    };
  }
  throw new Error(
    `Failed to resolve completion truth: ${resolution.notes?.join("; ") ?? "no result available"}`,
  );
}

export async function awaitCompletionTruthFromPublicHost<T = CompletionWorkerOutput>(params: {
  hook: CompletionTruthPublicHostHook<T>;
  parseRealtimeHint: (rawMessage: string) => T;
  timeoutMs?: number;
  waitPolicy?: Partial<CompletionTruthWaitPolicy>;
}): Promise<T> {
  return (await resolveCompletionTruthFromPublicHost(params)).output;
}
