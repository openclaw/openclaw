/**
 * Request Batcher - Batch similar requests for efficiency
 */

import { randomUUID } from "crypto";

export type RequestPriority = "low" | "normal" | "high" | "critical";

export interface BatchedRequest<T> {
  id: string;
  priority: RequestPriority;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  key: string;
}

interface BatcherOptions {
  maxBatchSize: number;
  batchWindowMs: number;
}

const DEFAULT_OPTIONS: BatcherOptions = {
  maxBatchSize: 10,
  batchWindowMs: 100,
};

export class RequestBatcher {
  private options: BatcherOptions;
  private pendingRequests: Map<string, BatchedRequest<unknown>[]>;
  private batchTimers: Map<string, NodeJS.Timeout>;

  constructor(options?: Partial<BatcherOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.pendingRequests = new Map();
    this.batchTimers = new Map();
  }

  async enqueue<T>(
    key: string,
    factory: () => Promise<T>,
    priority: RequestPriority = "normal",
  ): Promise<T> {
    const existingBatch = this.pendingRequests.get(key);

    if (existingBatch && existingBatch.length > 0) {
      return new Promise<T>((resolve, reject) => {
        const request: BatchedRequest<T> = {
          id: randomUUID(),
          priority,
          promise: Promise.resolve().then(() => factory()),
          resolve: resolve as (value: unknown) => void,
          reject,
          key,
        };

        this.insertByPriority(existingBatch, request as BatchedRequest<unknown>);

        if (existingBatch.length >= this.options.maxBatchSize) {
          this.flushBatch(key);
        }
      });
    }

    const batch: BatchedRequest<unknown>[] = [];
    this.pendingRequests.set(key, batch);

    const request = new Promise<T>((resolve, reject) => {
      const req: BatchedRequest<T> = {
        id: randomUUID(),
        priority,
        promise: Promise.resolve().then(() => factory()),
        resolve,
        reject,
        key,
      };
      batch.push(req as BatchedRequest<unknown>);
    });

    const timer = setTimeout(() => this.flushBatch(key), this.options.batchWindowMs);
    this.batchTimers.set(key, timer);

    return request;
  }

  private insertByPriority(
    batch: BatchedRequest<unknown>[],
    request: BatchedRequest<unknown>,
  ): void {
    const priorityOrder: Record<RequestPriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    let inserted = false;
    for (let i = 0; i < batch.length; i++) {
      if (priorityOrder[request.priority] < priorityOrder[batch[i].priority]) {
        batch.splice(i, 0, request);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      batch.push(request);
    }
  }

  private async flushBatch(key: string): Promise<void> {
    const timer = this.batchTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(key);
    }

    const batch = this.pendingRequests.get(key);
    if (!batch || batch.length === 0) {
      this.pendingRequests.delete(key);
      return;
    }

    this.pendingRequests.delete(key);

    if (batch.length === 1) {
      const request = batch[0];
      try {
        const result = await request.promise;
        request.resolve(result);
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    const uniqueFactories = new Map<
      string,
      { request: BatchedRequest<unknown>; factory: () => Promise<unknown> }
    >();

    for (const request of batch) {
      const existing = uniqueFactories.get(request.key);
      if (!existing || priorityHigher(request.priority, existing.request.priority)) {
        uniqueFactories.set(request.key, { request, factory: async () => await request.promise });
      }
    }

    const results = await Promise.allSettled(
      Array.from(uniqueFactories.values()).map((v) => v.factory()),
    );

    const entries = Array.from(uniqueFactories.entries());
    for (let i = 0; i < entries.length; i++) {
      const [, { request }] = entries[i];
      const result = results[i];

      if (result.status === "fulfilled") {
        request.resolve(result.value);
      } else {
        request.reject(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
      }
    }
  }

  clear(): void {
    for (const timer of Array.from(this.batchTimers.values())) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();

    for (const batch of Array.from(this.pendingRequests.values())) {
      for (const request of batch) {
        request.reject(new Error("Request batch cleared"));
      }
    }
    this.pendingRequests.clear();
  }
}

function priorityHigher(a: RequestPriority, b: RequestPriority): boolean {
  const order: Record<RequestPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  return order[a] < order[b];
}
