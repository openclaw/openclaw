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

const NON_RETRYABLE_MEMORY_EMBEDDING_ERROR_RE = new RegExp(
  [
    "(?:^|[^0-9])(?:400|401|403|404)(?:[^0-9]|$)",
    "invalid url",
    "failed to parse url",
    "malformed request",
  ].join("|"),
  "i",
);

const RETRYABLE_MEMORY_EMBEDDING_ERROR_RE = new RegExp(
  [
    "rate[_ ]limit",
    "too many requests",
    "429",
    "resource has been exhausted",
    "5\\d\\d",
    "cloudflare",
    "tokens per day",
    "\\bfetch failed\\b",
    "network error",
    "read ECONN",
    "timed out",
    "socket hang up",
    "connection (?:reset|refused|closed|terminated)",
    "other side closed",
    "temporarily unavailable",
    "upstream connect error",
    "disconnect/reset before headers",
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
    "EPROTO",
    "UND_ERR_[A-Z_]+",
  ].join("|"),
  "i",
);

export function isRetryableMemoryEmbeddingError(message: string): boolean {
  if (NON_RETRYABLE_MEMORY_EMBEDDING_ERROR_RE.test(message)) {
    return false;
  }
  return RETRYABLE_MEMORY_EMBEDDING_ERROR_RE.test(message);
}

export function isStructuredInputTooLargeMemoryEmbeddingError(message: string): boolean {
  return /(413|payload too large|request too large|input too large|too many tokens|input limit|request size)/i.test(
    message,
  );
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
}): Promise<T> {
  let attempt = 0;
  let delayMs = params.baseDelayMs;
  while (true) {
    try {
      return await params.run();
    } catch (err) {
      const message = formatErrorMessage(err);
      if (!params.isRetryable(message) || attempt >= params.maxAttempts) {
        throw err;
      }
      await params.waitForRetry(delayMs);
      delayMs *= 2;
      attempt += 1;
    }
  }
}

export function buildTextEmbeddingInputs(chunks: MemoryEmbeddingChunk[]): MemoryEmbeddingInput[] {
  return chunks.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
}
