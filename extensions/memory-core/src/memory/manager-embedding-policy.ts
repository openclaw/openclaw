// Memory Core plugin module implements manager embedding policy behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

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

/** Matches provider rate-limit errors (429, quota exhaustion) that need longer
 *  backoff than transient transport failures. */
const RATE_LIMIT_MEMORY_EMBEDDING_ERROR_RE =
  /(rate[_ ]limit|too many requests|429|resource has been exhausted|tokens per day)/i;

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

/** Returns true when the error is a provider-side rate limit (429, quota
 *  exhausted) that should use longer backoff than transient transport errors.
 *  Rate-limit windows are typically 60s; short retries land inside the same
 *  still-active window and waste attempts. */
function isRateLimitMemoryEmbeddingError(message: string): boolean {
  return RATE_LIMIT_MEMORY_EMBEDDING_ERROR_RE.test(message);
}

export function resolveMemoryEmbeddingRetryDelay(
  delayMs: number,
  randomValue: number,
  maxDelayMs: number,
): number {
  return Math.min(maxDelayMs, Math.round(delayMs * (1 + randomValue * 0.2)));
}

export async function runMemoryEmbeddingRetryLoop<T>(params: {
  run: () => Promise<T>;
  isRetryable: (message: string) => boolean;
  waitForRetry: (delayMs: number) => Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
  /** When provided, rate-limit errors (429, quota exhaustion) use these
   *  longer backoff parameters instead of the default exponential schedule.
   *  Rate-limit windows are typically 60s; short retries waste attempts. */
  rateLimitBaseDelayMs?: number;
  rateLimitMaxDelayMs?: number;
  /** When provided, rate-limit errors use this many attempts instead of
   *  the shared maxAttempts.  Defaults to maxAttempts when unset. */
  rateLimitMaxAttempts?: number;
  /** When provided and a rate-limit error is detected, extracts the
   *  server-specified retry-after duration (in ms) from the error. If the
   *  extracted value exceeds the computed backoff, it overrides it (still
   *  capped at rateLimitMaxDelayMs). This honors provider Retry-After
   *  headers so retries clear the cooldown window. */
  extractRetryAfterMs?: (err: unknown) => number | undefined;
  /** Caller-owned cancellation; an aborted caller stops the retry loop. */
  signal?: AbortSignal;
}): Promise<T> {
  const maxAttempts = Math.max(1, params.maxAttempts);
  const rlBaseDelay = params.rateLimitBaseDelayMs ?? params.baseDelayMs;
  const rlMaxDelay = params.rateLimitMaxDelayMs ?? 60_000;
  const rlMaxAttempts = Math.max(1, params.rateLimitMaxAttempts ?? maxAttempts);
  const extractRetryAfter = params.extractRetryAfterMs;
  const totalAttempts = Math.max(maxAttempts, rlMaxAttempts);
  for (const attempt of Array.from({ length: totalAttempts }, (_, index) => index + 1)) {
    try {
      return await params.run();
    } catch (err) {
      // Abort must win over retryable-looking failures: abort reasons often
      // carry "timed out" messages that match the retryable transport
      // patterns and would otherwise keep retrying for an absent caller.
      if (params.signal?.aborted) {
        throw err;
      }
      const message = formatErrorMessage(err);
      const isRateLimit = isRateLimitMemoryEmbeddingError(message);
      const effectiveMax = isRateLimit ? rlMaxAttempts : maxAttempts;
      if (!params.isRetryable(message) || attempt >= effectiveMax) {
        throw err;
      }
      // Rate-limit errors use a separate, longer backoff schedule so retries
      // clear the provider's rate-limit window instead of landing inside it.
      let delayMs = isRateLimit
        ? Math.min(rlMaxDelay, rlBaseDelay * 2 ** (attempt - 1))
        : params.baseDelayMs * 2 ** (attempt - 1);
      // Honor provider-specified Retry-After when available and longer than
      // the computed backoff (still capped at the rate-limit ceiling).
      if (isRateLimit && extractRetryAfter) {
        const retryAfterMs = extractRetryAfter(err);
        if (typeof retryAfterMs === "number" && retryAfterMs > delayMs) {
          delayMs = Math.min(rlMaxDelay, retryAfterMs);
        }
      }
      await params.waitForRetry(delayMs);
    }
  }
  throw new Error("retry loop exhausted");
}

export async function runMemoryEmbeddingBatchRetryWithSplit<TInput, TOutput>(params: {
  items: TInput[];
  run: (items: TInput[]) => Promise<TOutput[]>;
  isRetryable: (message: string) => boolean;
  isSplittable: (message: string) => boolean;
  waitForRetry: (delayMs: number) => Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
  rateLimitBaseDelayMs?: number;
  rateLimitMaxDelayMs?: number;
  rateLimitMaxAttempts?: number;
  extractRetryAfterMs?: (err: unknown) => number | undefined;
  onSplit?: (info: { itemCount: number; splitAt: number; message: string }) => void;
}): Promise<TOutput[]> {
  try {
    return await runMemoryEmbeddingRetryLoop({
      run: async () => await params.run(params.items),
      isRetryable: params.isRetryable,
      waitForRetry: params.waitForRetry,
      maxAttempts: params.maxAttempts,
      baseDelayMs: params.baseDelayMs,
      rateLimitBaseDelayMs: params.rateLimitBaseDelayMs,
      rateLimitMaxDelayMs: params.rateLimitMaxDelayMs,
      rateLimitMaxAttempts: params.rateLimitMaxAttempts,
      extractRetryAfterMs: params.extractRetryAfterMs,
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
