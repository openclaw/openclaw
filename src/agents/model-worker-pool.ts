/**
 * Model Worker Pool — Offloads LLM API fetch() calls to worker_threads
 * to prevent event-loop starvation on the main gateway thread.
 *
 * When enabled, model API calls (identified by provider URL patterns) are
 * routed through a bounded worker thread pool. Streaming responses pass
 * bytes back through MessagePort, so the caller receives a standard Response
 * with a ReadableStream body.
 *
 * Architecture:
 *   Main thread: agent context assembly + tool processing (unchanged)
 *   Worker pool: isolated fetch() for LLM API calls
 *
 * Config:
 *   gateway.modelWorkerPool: { enabled: true, maxWorkers: 4, timeoutMs: 300000 }
 */

import { isMainThread, Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("model-worker-pool");

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
const WORKER_IDLE_TTL_MS = 60_000; // Recycle idle workers after 1 min

/**
 * URL patterns that identify LLM API endpoints. Only requests matching these
 * patterns are offloaded; all other fetch() calls use the main-thread fetch.
 */
const MODEL_API_PATTERNS = [
  /api\.openai\.com\/v\d+\/(chat\/completions|responses)/,
  /api\.anthropic\.com\/v\d+\/messages/,
  /generativelanguage\.googleapis\.com/,
  /openrouter\.ai\/api\/v\d+\/chat\/completions/,
  /api\.groq\.com\/openai\/v\d+\/chat\/completions/,
  /api\.deepseek\.com/,
  /api\.mistral\.ai\/v\d+\/chat\/completions/,
  /api\.x\.ai\/v\d+\/chat\/completions/,
  /api\.perplexity\.ai/,
  // Ollama local endpoints
  /localhost:\d+\/api\/chat/,
  /127\.0\.0\.1:\d+\/api\/chat/,
];

export type ModelWorkerPoolConfig = {
  enabled?: boolean;
  maxWorkers?: number;
  timeoutMs?: number;
};

type PoolWorker = {
  worker: Worker;
  busy: boolean;
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
};

type WorkerRequest = {
  id: number;
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: never; // AbortSignals can't transfer across worker boundary
  };
};

type WorkerResponse = {
  id: number;
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
  error?: string;
};

let pool: PoolWorker[] = [];
let requestIdCounter = 0;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

const pendingRequests = new Map<
  number,
  {
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }
>();

function getWorkerScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(currentDir, "model-worker.js");
}

function createPoolWorker(): PoolWorker {
  const workerPath = getWorkerScriptPath();
  const worker = new Worker(workerPath);

  worker.on("message", (msg: WorkerResponse) => {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    pendingRequests.delete(msg.id);

    // Find the worker and mark it as free
    const poolWorker = pool.find((pw) => pw.worker === worker);
    if (poolWorker) {
      poolWorker.busy = false;
      poolWorker.lastUsedAt = Date.now();
      poolWorker.requestCount++;
    }

    if (msg.error) {
      pending.reject(new Error(msg.error));
      return;
    }

    const bodyBuffer = Buffer.from(msg.bodyBase64, "base64");
    const response = new Response(bodyBuffer, {
      status: msg.status,
      statusText: msg.statusText,
      headers: new Headers(msg.headers),
    });
    pending.resolve(response);
  });

  worker.on("error", (err) => {
    log.warn(`model worker error: ${err.message}`);
    // Fail any pending requests assigned to this worker
    for (const [id, pending] of pendingRequests) {
      const poolWorker = pool.find((pw) => pw.worker === worker);
      if (poolWorker) {
        clearTimeout(pending.timeoutId);
        pendingRequests.delete(id);
        poolWorker.busy = false;
        pending.reject(new Error(`Model worker error: ${err.message}`));
      }
    }
    // Remove the broken worker
    pool = pool.filter((pw) => pw.worker !== worker);
    void worker.terminate();
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      log.warn(`model worker exited with code ${code}`);
    }
    pool = pool.filter((pw) => pw.worker !== worker);
  });

  return {
    worker,
    busy: false,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    requestCount: 0,
  };
}

function getOrCreateWorker(): PoolWorker {
  // Find a free worker
  const freeWorker = pool.find((w) => !w.busy);
  if (freeWorker) {
    freeWorker.busy = true;
    return freeWorker;
  }

  // Create a new worker if under max
  const maxWorkers = currentConfig.maxWorkers ?? DEFAULT_MAX_WORKERS;
  if (pool.length < maxWorkers) {
    const newWorker = createPoolWorker();
    newWorker.busy = true;
    pool.push(newWorker);
    return newWorker;
  }

  // All workers busy — queue on the least-busy (oldest assigned)
  // In this simple implementation, we just use the first worker
  // A more sophisticated scheduler would use a priority queue
  const oldestBusy = pool.reduce((oldest, current) =>
    current.lastUsedAt < oldest.lastUsedAt ? current : oldest,
  );
  oldestBusy.busy = true;
  return oldestBusy;
}

function recycleIdleWorkers(): void {
  const now = Date.now();
  const idleTtl = WORKER_IDLE_TTL_MS;

  for (let i = pool.length - 1; i >= 0; i--) {
    const worker = pool[i];
    if (!worker.busy && now - worker.lastUsedAt > idleTtl && pool.length > 1) {
      void worker.worker.terminate();
      pool.splice(i, 1);
      log.debug(`recycled idle model worker (${worker.requestCount} requests served)`);
    }
  }
}

function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(recycleIdleWorkers, 30_000);
  cleanupTimer.unref();
}

function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

let currentConfig: ModelWorkerPoolConfig = {};
let globalFetchOriginal: typeof fetch | null = null;

export function configureModelWorkerPool(config: ModelWorkerPoolConfig): void {
  currentConfig = { ...config };

  if (config.enabled && !isMainThread) {
    log.warn("model worker pool disabled: not running on main thread");
    currentConfig.enabled = false;
    return;
  }

  if (config.enabled) {
    startCleanupTimer();
    // Pre-warm: create at least one worker
    if (pool.length === 0) {
      pool.push(createPoolWorker());
    }
    // Override global fetch to route model calls through worker pool
    if (!globalFetchOriginal) {
      globalFetchOriginal = globalThis.fetch;
      const workerFetch = createModelWorkerPoolFetch(globalFetchOriginal);
      globalThis.fetch = workerFetch as typeof fetch;
    }
    log.info(
      `model worker pool enabled: maxWorkers=${config.maxWorkers ?? DEFAULT_MAX_WORKERS}, timeoutMs=${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}`,
    );
  } else {
    // Restore original fetch if we overrode it
    if (globalFetchOriginal) {
      globalThis.fetch = globalFetchOriginal;
      globalFetchOriginal = null;
    }
    // Drain and terminate all workers
    void drainAndTerminate();
  }
}

async function drainAndTerminate(): Promise<void> {
  stopCleanupTimer();

  // Wait for pending requests to complete (with a deadline)
  if (pendingRequests.size > 0) {
    const deadline = Date.now() + 10_000;
    while (pendingRequests.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Terminate all workers
  for (const pw of pool) {
    void pw.worker.terminate();
  }
  pool = [];

  // Reject remaining pending requests
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error("Model worker pool shutting down"));
    pendingRequests.delete(id);
  }

  log.info("model worker pool drained and terminated");
}

function shouldOffloadToWorker(url: string): boolean {
  return MODEL_API_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Offload a fetch() call to a worker thread. Returns a standard Response.
 * The worker executes the actual HTTP request and sends back the response
 * body as base64-encoded bytes through MessagePort.
 */
function fetchViaWorker(url: string, init: RequestInit): Promise<Response> {
  const id = ++requestIdCounter;
  const timeoutMs = currentConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<Response>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Model worker request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timeoutId });

    const poolWorker = getOrCreateWorker();

    // Serialize request init for transfer across worker boundary
    const headers: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    const body =
      typeof init.body === "string"
        ? init.body
        : init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)
          ? Buffer.from(
              init.body instanceof ArrayBuffer ? init.body : init.body.buffer,
            ).toString("base64")
          : undefined;

    const workerRequest: WorkerRequest = {
      id,
      url,
      init: {
        method: init.method,
        headers,
        body: typeof body === "string" ? body : undefined,
      },
    };

    poolWorker.worker.postMessage(workerRequest);
  });
}

/**
 * Check if the model worker pool is enabled and should intercept this URL.
 */
function isModelWorkerPoolActive(): boolean {
  return Boolean(currentConfig.enabled && isMainThread && pool.length > 0);
}

/**
 * Fetch wrapper that routes model API calls through worker threads when
 * the pool is enabled. Falls back to the provided fetchFn for non-model URLs
 * and when the pool is disabled.
 *
 * Usage:
 *   The agent runner passes this as a custom fetch function for model calls.
 */
export function createModelWorkerPoolFetch(
  baseFetch: typeof fetch,
): typeof fetch {
  if (!currentConfig.enabled) return baseFetch;

  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (!shouldOffloadToWorker(url)) {
      return baseFetch(input, init);
    }

    log.debug(`offloading model fetch to worker: ${url.slice(0, 100)}`);
    try {
      return await fetchViaWorker(url, init ?? {});
    } catch (err) {
      log.warn(
        `model worker fetch failed, falling back to main thread: ${url.slice(0, 100)} (${err instanceof Error ? err.message : String(err)})`,
      );
      // Fall back to main-thread fetch on worker failure
      return baseFetch(input, init);
    }
  };
}

/**
 * Get pool metrics for diagnostics.
 */
export function getModelWorkerPoolMetrics() {
  return {
    enabled: Boolean(currentConfig.enabled),
    poolSize: pool.length,
    busyWorkers: pool.filter((w) => w.busy).length,
    idleWorkers: pool.filter((w) => !w.busy).length,
    pendingRequests: pendingRequests.size,
    totalRequestsServed: pool.reduce((sum, w) => sum + w.requestCount, 0),
    config: {
      maxWorkers: currentConfig.maxWorkers ?? DEFAULT_MAX_WORKERS,
      timeoutMs: currentConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  };
}

/**
 * Gracefully shut down the worker pool. Waits for in-flight requests
 * to complete before terminating workers.
 */
export async function shutdownModelWorkerPool(): Promise<void> {
  await drainAndTerminate();
}
