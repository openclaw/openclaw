/**
 * Unified embedding system with:
 *  - Cascading fallback: auto → local → openai → gemini → voyage → transformer → noop (BM25)
 *  - Transformer provider (local ONNX via @xenova/transformers)
 *  - Noop/BM25 fallback for graceful degradation
 *  - Hash embedding for deterministic, last-resort fallback
 *  - 429 retry-with-backoff
 *  - Dim-mismatch protection
 */

export type EmbeddingFtsConfig = {
  provider?: "auto" | "openai" | "gemini" | "local" | "voyage" | "transformer" | "none";
  fallback?: "openai" | "gemini" | "local" | "voyage" | "transformer" | "none";
  model?: string;
  retryBaseDelayMs?: number;
  retryMaxAttempts?: number;
};

export interface EmbeddingProvider {
  id: string;
  model: string;
  dim: number;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

/**
 * Create a noop embedding provider that returns empty vectors.
 * Used as last-resort when no real embeddings are available,
 * allowing keyword-only (FTS/BM25) search to remain usable.
 */
export function createNoopEmbeddingProvider(): EmbeddingProvider {
  return {
    id: "none",
    model: "none",
    dim: 0,
    embedQuery: async () => [],
    embedBatch: async (texts) => texts.map(() => []),
  };
}

/**
 * Create a hash-based embedding provider that produces deterministic
 * fixed-dimension vectors from text content. Useful as a fallback
 * when no real embedding models are available.
 */
export function createHashEmbeddingProvider(dim: number = 128): EmbeddingProvider {
  function hashEmbed(text: string): number[] {
    const vec = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const idx = (charCode * 31 + i * 7) % dim;
      vec[idx] += 1;
    }
    // L2 normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vec[i] /= norm;
      }
    }
    return vec;
  }

  return {
    id: "hash",
    model: "hash",
    dim,
    embedQuery: async (text) => hashEmbed(text),
    embedBatch: async (texts) => texts.map(hashEmbed),
  };
}

/**
 * Create a transformer-based embedding provider using @xenova/transformers
 * for local ONNX inference. Returns 384-dim L2-normalized vectors by default
 * (Xenova/all-MiniLM-L6-v2).
 */
export async function createTransformerEmbeddingProvider(
  modelName: string = "Xenova/all-MiniLM-L6-v2",
): Promise<EmbeddingProvider> {
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowLocalModels = true;
  env.useBrowserCache = false;

  const pipe = await pipeline("feature-extraction", modelName);

  async function embed(text: string): Promise<number[]> {
    const result = await pipe(text);
    const rawData = result.data as Float32Array;
    const vec = Array.from(rawData);
    // L2 normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }
    return vec;
  }

  const sampleVec = await embed("dim probe");
  const dim = sampleVec.length;

  return {
    id: "transformer",
    model: modelName,
    dim,
    embedQuery: embed,
    embedBatch: async (texts) => {
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await embed(text));
      }
      return results;
    },
  };
}

/**
 * Wrap an embedding provider with 429 retry-with-backoff logic.
 * When `embedQuery` or `embedBatch` throws a rate-limit error (status 429),
 * it retries with exponential backoff.
 */
export function withRetryBackoff(
  provider: EmbeddingProvider,
  opts?: { baseDelayMs?: number; maxAttempts?: number },
): EmbeddingProvider {
  const baseDelay = opts?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;

  function isRateLimitError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return msg.includes("429") || msg.includes("rate") || msg.includes("quota");
    }
    return false;
  }

  async function retryable<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isRateLimitError(err) || attempt >= maxAttempts - 1) {
          throw err;
        }
        const delay = Math.min(baseDelay * 2 ** attempt, 60_000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  return {
    ...provider,
    embedQuery: (text) => retryable(() => provider.embedQuery(text)),
    embedBatch: (texts) => retryable(() => provider.embedBatch(texts)),
  };
}

/**
 * Probe whether an embedding provider is actually producing real vectors.
 * Returns `{ ok: false }` when the provider is a noop/keyword-only fallback.
 */
export async function probeEmbeddingAvailability(
  provider: EmbeddingProvider,
): Promise<{ ok: boolean; dim: number; error?: string }> {
  try {
    const vec = await provider.embedQuery("ping");
    if (!Array.isArray(vec) || vec.length === 0) {
      return { ok: false, dim: 0, error: "Embeddings unavailable (keyword-only mode)." };
    }
    return { ok: true, dim: vec.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, dim: 0, error: message };
  }
}

/**
 * Detect dim-mismatch between a stored vector and the current provider.
 * Returns true if the dimensions don't match, meaning re-embedding is needed.
 */
export function isDimMismatch(storedDim: number, providerDim: number): boolean {
  if (storedDim === 0 || providerDim === 0) {
    return false; // noop/hash fallback — no real dim to compare
  }
  return storedDim !== providerDim;
}
