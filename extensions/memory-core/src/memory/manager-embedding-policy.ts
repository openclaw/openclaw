import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
  type EmbeddingInput,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

// Retry attempts are host control state. Provider-thrown values stay opaque so
// they cannot override the counter or break accounting when they are immutable.
type MemoryBatchRetryResult =
  | { kind: "success"; value: number[][] | null }
  | { kind: "failure"; error: unknown; attempts: 1 | 2 };

export async function runMemoryEmbeddingBatchTimeoutRetry(params: {
  onRetry: () => void;
  run: () => Promise<number[][] | null>;
}): Promise<MemoryBatchRetryResult> {
  let attempts: 1 | 2 = 1;
  while (true) {
    try {
      return { kind: "success", value: await params.run() };
    } catch (error) {
      if (attempts === 2 || !/timed out|timeout/i.test(formatErrorMessage(error))) {
        return { kind: "failure", error, attempts };
      }
    }
    params.onRetry();
    attempts = 2;
  }
}

type MemoryEmbeddingChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};

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
    current.push(chunk);
    currentTokens += estimate;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

const RATE_LIMITED_MEMORY_EMBEDDING_ERROR_RE =
  /(rate[_ ]limit|too many requests|\b429\b|resource has been exhausted|tokens per day)/i;

const RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE = /\b5\d\d\b|cloudflare/i;

const RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(fetch failed|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|socket terminated|network error|read ECONN|timed out|connection (?:reset|refused|aborted|timed out)|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EAI_AGAIN)/i;

// Zhipu's item cap is reported as `input array max 64` (English) or
// `input数组最大不得超过64条` (Chinese). Require the whole count and
// message boundary so per-item and token limits remain terminal.
const SPLITTABLE_MEMORY_EMBEDDING_BATCH_ERROR_RE =
  /(request_headers_too_large|request header fields too large|other side closed|ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|socket terminated|read ECONN|connection (?:reset|aborted)|\bembeddings (?:api input limit exceeded:\s*max\s+\d+\s*,\s*got\s+\d+|max input length is\s+\d+)\b|\bbatch size is invalid,?\s+it should not be larger than\s+\d+\b|\binput array max\s+\d+(?=\s*(?:["'}]|$))|input\s*数组最大不得超过\s*\d+\s*条)/i;

const SHORT_MEMORY_EMBEDDING_RETRY_BUDGET = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
} as const;
const MEMORY_EMBEDDING_RETRY_PROFILES = {
  index: {
    transient: SHORT_MEMORY_EMBEDDING_RETRY_BUDGET,
    rateLimit: { attempts: 5, baseDelayMs: 5000, maxDelayMs: 60_000 },
    maxTotalWaitMs: Number.POSITIVE_INFINITY,
  },
  query: {
    transient: SHORT_MEMORY_EMBEDDING_RETRY_BUDGET,
    rateLimit: SHORT_MEMORY_EMBEDDING_RETRY_BUDGET,
    maxTotalWaitMs: 8000,
  },
} as const;
export type MemoryEmbeddingRetryProfileName = keyof typeof MEMORY_EMBEDDING_RETRY_PROFILES;

type MemoryEmbeddingRetryBudget = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number;
};

const MEMORY_EMBEDDING_BATCH_ITEM_LIMIT_RE =
  /\b(?:embeddings api input limit exceeded:\s*max\s+(\d+)\s*,\s*got\s+\d+|embeddings max input length is\s+(\d+(?:\.\d+)?)|batch size is invalid,?\s+it should not be larger than\s+(\d+(?:\.\d+)?)|input array max\s+(\d+)(?=\s*(?:["'}]|$))|input\s*数组最大不得超过\s*(\d+)\s*条)/gi;

function parseMemoryEmbeddingBatchItemLimit(message: string): number | undefined {
  const limits = new Set<number>();
  for (const match of message.matchAll(MEMORY_EMBEDDING_BATCH_ITEM_LIMIT_RE)) {
    const value = Number(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      return undefined;
    }
    limits.add(value);
  }
  return limits.size === 1 ? limits.values().next().value : undefined;
}

function isInvalidEmbeddingResponse(error: unknown): boolean {
  // Diagnostic counts and model names must not be mistaken for HTTP status or input limits.
  return asOptionalRecord(error)?.code === "INVALID_EMBEDDING_RESPONSE";
}

function embeddingRetryMessage(error: unknown): string {
  const message = asOptionalRecord(error)?.embeddingErrorMessage;
  return typeof message === "string" ? message : formatErrorMessage(error);
}

function resolveMemoryEmbeddingRetryBudget(
  profile: (typeof MEMORY_EMBEDDING_RETRY_PROFILES)[MemoryEmbeddingRetryProfileName],
  error: unknown,
): MemoryEmbeddingRetryBudget | undefined {
  if (isInvalidEmbeddingResponse(error)) {
    return undefined;
  }
  const fields = asOptionalRecord(error);
  const message = embeddingRetryMessage(error);
  const cooldown = fields?.retryAfterMs;
  const retryAfterMs =
    typeof cooldown === "number" && Number.isSafeInteger(cooldown) && cooldown >= 0
      ? cooldown
      : undefined;
  const status = [fields?.status, fields?.statusCode].find(
    (value): value is number => typeof value === "number" && Number.isInteger(value),
  );
  const permanentQuota = [fields?.errorCode, fields?.code, fields?.errorType].some((value) => {
    const code = normalizeOptionalString(value)?.toLowerCase();
    return code === "quota_exceeded" || code === "insufficient_quota";
  });
  if (permanentQuota && retryAfterMs === undefined) {
    return undefined;
  }
  if (status === 429) {
    return { ...profile.rateLimit, retryAfterMs };
  }
  if (status !== undefined) {
    return status >= 500 && status <= 599 ? profile.transient : undefined;
  }
  if (RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message)) {
    return profile.transient;
  }
  if (SPLITTABLE_MEMORY_EMBEDDING_BATCH_ERROR_RE.test(message)) {
    return undefined;
  }
  if (RATE_LIMITED_MEMORY_EMBEDDING_ERROR_RE.test(message)) {
    return { ...profile.rateLimit, retryAfterMs };
  }
  return RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE.test(message) ? profile.transient : undefined;
}

export async function runMemoryEmbeddingRetryLoop<T>(params: {
  profile: MemoryEmbeddingRetryProfileName;
  run: () => Promise<T>;
  waitForRetry: (delayMs: number) => Promise<void>;
  /** Caller-owned cancellation; an aborted caller stops the retry loop. */
  signal?: AbortSignal;
}): Promise<T> {
  const profile = MEMORY_EMBEDDING_RETRY_PROFILES[params.profile];
  let remainingWaitMs = profile.maxTotalWaitMs;
  return await retryAsync(params.run, {
    attempts: profile.rateLimit.attempts,
    minDelayMs: profile.transient.baseDelayMs,
    maxDelayMs: profile.rateLimit.maxDelayMs,
    retryAfterMaxDelayMs: profile.rateLimit.maxDelayMs,
    jitter: 0.2,
    // Caller cancellation wins even when its timeout resembles a retryable
    // provider error; otherwise abandoned searches start another request.
    shouldRetry: (err, attempt) => {
      if (params.signal?.aborted) {
        return false;
      }
      const retryBudget = resolveMemoryEmbeddingRetryBudget(profile, err);
      return retryBudget !== undefined && attempt < retryBudget.attempts;
    },
    delayMs: ({ attempt, err }) => {
      const retryBudget = resolveMemoryEmbeddingRetryBudget(profile, err);
      return retryBudget
        ? Math.min(retryBudget.maxDelayMs, retryBudget.baseDelayMs * 2 ** (attempt - 1))
        : 0;
    },
    retryAfterMs: (err) => resolveMemoryEmbeddingRetryBudget(profile, err)?.retryAfterMs,
    sleep: async (delayMs) => {
      const boundedDelayMs = Math.min(delayMs, remainingWaitMs);
      remainingWaitMs -= boundedDelayMs;
      await params.waitForRetry(boundedDelayMs);
    },
  });
}

export async function runMemoryEmbeddingBatchRetryWithSplit<TInput, TOutput>(params: {
  items: TInput[];
  run: (items: TInput[]) => Promise<TOutput[]>;
  onSuccess?: (items: TInput[], outputs: TOutput[]) => void | Promise<void>;
  waitForRetry: (delayMs: number) => Promise<void>;
  onSplit?: (info: { itemCount: number; splitAt: number; message: string }) => void;
}): Promise<TOutput[]> {
  let outputs: TOutput[];
  try {
    outputs = await runMemoryEmbeddingRetryLoop({
      profile: "index",
      run: async () => await params.run(params.items),
      waitForRetry: params.waitForRetry,
    });
  } catch (err) {
    const message = embeddingRetryMessage(err);
    if (
      isInvalidEmbeddingResponse(err) ||
      params.items.length <= 1 ||
      !SPLITTABLE_MEMORY_EMBEDDING_BATCH_ERROR_RE.test(message)
    ) {
      throw err;
    }

    const itemLimit = parseMemoryEmbeddingBatchItemLimit(message);
    const splitAt =
      itemLimit !== undefined && itemLimit < params.items.length
        ? itemLimit
        : Math.ceil(params.items.length / 2);
    params.onSplit?.({ itemCount: params.items.length, splitAt, message });
    const results: TOutput[] = [];
    for (let start = 0; start < params.items.length; start += splitAt) {
      results.push(
        ...(await runMemoryEmbeddingBatchRetryWithSplit({
          ...params,
          items: params.items.slice(start, start + splitAt),
        })),
      );
    }
    return results;
  }
  await params.onSuccess?.(params.items, outputs);
  return outputs;
}
