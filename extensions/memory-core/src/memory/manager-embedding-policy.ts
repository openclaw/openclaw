// Memory Core plugin module implements manager embedding policy behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

type MemoryEmbeddingTextPart = {
  type: "text";
  text: string;
};

type MemoryEmbeddingInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};

type MemoryEmbeddingInput = {
  text: string;
  parts?: Array<MemoryEmbeddingTextPart | MemoryEmbeddingInlineDataPart>;
};

type MemoryEmbeddingChunk = {
  text: string;
  embeddingInput?: MemoryEmbeddingInput;
};

function estimateUtf8Bytes(text: string): number {
  if (!text) {
    return 0;
  }
  return Buffer.byteLength(text, "utf8");
}

function estimateStructuredEmbeddingInputBytes(input: MemoryEmbeddingInput): number {
  if (!input.parts?.length) {
    return estimateUtf8Bytes(input.text);
  }
  let total = 0;
  for (const part of input.parts) {
    if (part.type === "text") {
      total += estimateUtf8Bytes(part.text);
    } else {
      total += estimateUtf8Bytes(part.mimeType);
      total += estimateUtf8Bytes(part.data);
    }
  }
  return total;
}

export function filterNonEmptyMemoryChunks<T extends MemoryEmbeddingChunk>(chunks: T[]): T[] {
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

export function buildMemoryEmbeddingBatches<T extends MemoryEmbeddingChunk>(
  chunks: T[],
  maxTokens: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;

  for (const chunk of chunks) {
    const estimate = chunk.embeddingInput
      ? estimateStructuredEmbeddingInputBytes(chunk.embeddingInput)
      : estimateUtf8Bytes(chunk.text);
    const wouldExceed = current.length > 0 && currentTokens + estimate > maxTokens;
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && estimate > maxTokens) {
      batches.push([chunk]);
      continue;
    }
    current.push(chunk);
    currentTokens += estimate;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

const RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE =
  /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare|tokens per day)/i;

const RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(fetch failed|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|socket terminated|network error|read ECONN|timed out|connection (?:reset|refused|aborted|timed out)|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EAI_AGAIN)/i;

const SPLITTABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(request_headers_too_large|request header fields too large|other side closed|ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|socket terminated|read ECONN|connection (?:reset|aborted))/i;

function isRetryableMemoryEmbeddingTransportError(message: string): boolean {
  return RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message);
}

export function isSplittableMemoryEmbeddingTransportError(message: string): boolean {
  return SPLITTABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message);
}

export function isRetryableMemoryEmbeddingError(message: string): boolean {
  return (
    RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE.test(message) ||
    isRetryableMemoryEmbeddingTransportError(message)
  );
}

export function resolveMemoryEmbeddingRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : undefined;
}

export function createMemoryEmbeddingRetryCooldown(): {
  publish: (retryAfterMs: number | undefined) => void;
  wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
} {
  let retryNotBeforeMs = 0;
  return {
    publish: (retryAfterMs) => {
      if (retryAfterMs !== undefined) {
        retryNotBeforeMs = Math.max(retryNotBeforeMs, Date.now() + retryAfterMs);
      }
    },
    wait: async (delayMs, signal) => {
      const waiterNotBeforeMs = Date.now() + delayMs;
      while (true) {
        signal?.throwIfAborted();
        const remainingMs = Math.max(0, Math.max(waiterNotBeforeMs, retryNotBeforeMs) - Date.now());
        if (remainingMs === 0) {
          return;
        }
        // Re-check after sleeping because another concurrent batch may publish a
        // longer provider cooldown while this waiter is already paused.
        await sleepWithAbort(remainingMs, signal);
      }
    },
  };
}

export async function runMemoryEmbeddingRetryLoop<T>(params: {
  run: () => Promise<T>;
  isRetryable: (message: string) => boolean;
  waitForRetry: (delayMs: number, error: unknown) => Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (error: unknown) => void;
  random?: () => number;
  /** Caller-owned cancellation; an aborted caller stops the retry loop. */
  signal?: AbortSignal;
}): Promise<T> {
  let retryError: unknown;
  return await retryAsync(params.run, {
    attempts: params.maxAttempts,
    minDelayMs: params.baseDelayMs,
    maxDelayMs: params.maxDelayMs,
    retryAfterMaxDelayMs: params.maxDelayMs,
    retryAfterMs: params.retryAfterMs,
    jitter: 0.2,
    random: params.random,
    shouldRetry: (err) => {
      // Abort must win over retryable-looking failures: abort reasons often
      // carry "timed out" messages that match the retryable transport
      // patterns and would otherwise keep retrying for an absent caller.
      if (params.signal?.aborted) {
        return false;
      }
      const message = formatErrorMessage(err);
      if (!params.isRetryable(message)) {
        return false;
      }
      const retryAfterMs = params.retryAfterMs?.(err);
      return retryAfterMs === undefined || retryAfterMs <= params.maxDelayMs;
    },
    onRetry: ({ err }) => {
      retryError = err;
      params.onRetry?.(err);
    },
    sleep: async (delayMs) => {
      const error = retryError;
      retryError = undefined;
      await params.waitForRetry(delayMs, error);
    },
  });
}

export async function runMemoryEmbeddingBatchRetryWithSplit<TInput, TOutput>(params: {
  items: TInput[];
  run: (items: TInput[]) => Promise<TOutput[]>;
  isRetryable: (message: string) => boolean;
  isSplittable: (message: string) => boolean;
  waitForRetry: (delayMs: number, error: unknown) => Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (error: unknown) => void;
  random?: () => number;
  onSplit?: (info: { itemCount: number; splitAt: number; message: string }) => void;
}): Promise<TOutput[]> {
  try {
    return await runMemoryEmbeddingRetryLoop({
      run: async () => await params.run(params.items),
      isRetryable: params.isRetryable,
      waitForRetry: params.waitForRetry,
      maxAttempts: params.maxAttempts,
      baseDelayMs: params.baseDelayMs,
      maxDelayMs: params.maxDelayMs,
      retryAfterMs: params.retryAfterMs,
      onRetry: params.onRetry,
      random: params.random,
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    if (params.items.length <= 1 || !params.isSplittable(message)) {
      throw err;
    }

    const splitAt = Math.ceil(params.items.length / 2);
    params.onSplit?.({ itemCount: params.items.length, splitAt, message });
    const left = await runMemoryEmbeddingBatchRetryWithSplit({
      ...params,
      items: params.items.slice(0, splitAt),
    });
    const right = await runMemoryEmbeddingBatchRetryWithSplit({
      ...params,
      items: params.items.slice(splitAt),
    });
    return [...left, ...right];
  }
}

export function buildTextEmbeddingInputs(chunks: MemoryEmbeddingChunk[]): MemoryEmbeddingInput[] {
  return chunks.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
}
