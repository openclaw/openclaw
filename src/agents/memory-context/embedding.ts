import { createHash } from "node:crypto";

export type EmbeddingProvider = {
  dim: number;
  embed(text: string): Promise<number[]>;
  init?(): Promise<void>;
};

/**
 * Simple local embedding using hashed character n-grams.
 *
 * Goals:
 * - deterministic
 * - no external API keys
 * - similar text -> similar vectors (keyword overlap)
 */
export class HashEmbedding implements EmbeddingProvider {
  constructor(
    public readonly dim: number,
    private readonly ngram = 3,
  ) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`HashEmbedding: invalid dim ${dim}`);
    }
    if (!Number.isInteger(ngram) || ngram <= 0 || ngram > 10) {
      throw new Error(`HashEmbedding: invalid ngram ${ngram}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    const normalized = normalizeText(text);
    const vec = new Array<number>(this.dim).fill(0);

    const grams = charNgrams(normalized, this.ngram);
    if (grams.length === 0) {
      return vec;
    }

    for (const g of grams) {
      // Use sha256 for stable hashing across node versions.
      const digest = createHash("sha256").update(g).digest();
      const idx = digest.readUInt32LE(0) % this.dim;
      // signed-ish contribution
      const sign = (digest[4] & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }

    // Normalize to unit length for cosine similarity.
    let norm = 0;
    for (const v of vec) {
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] = vec[i] / norm;
      }
    }

    return vec;
  }
}

/**
 * Semantic embedding using @xenova/transformers (ONNX runtime).
 *
 * Uses sentence-transformers models like all-MiniLM-L6-v2 for true semantic similarity.
 * Model is downloaded on first use and cached in ~/.cache/
 */
export class TransformerEmbedding implements EmbeddingProvider {
  readonly dim = 384;
  private pipeline: any = null;
  private initPromise: Promise<void> | null = null;
  private modelName: string;

  constructor(modelName = "Xenova/all-MiniLM-L6-v2") {
    this.modelName = modelName;
  }

  async init(): Promise<void> {
    if (this.pipeline) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const {
        pipeline,
        env,
      } = // @ts-ignore optional dependency
        await import("@xenova/transformers");
      // Disable local model check to allow downloading
      env.allowLocalModels = true;
      env.useBrowserCache = false;

      this.pipeline = await pipeline("feature-extraction", this.modelName, {
        quantized: true, // Use quantized model for smaller size
      });
    } catch (err) {
      this.initPromise = null;
      throw new Error(
        `TransformerEmbedding: failed to load model ${this.modelName}: ${String(err)}`,
        { cause: err },
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.init();

    if (!this.pipeline) {
      throw new Error("TransformerEmbedding: pipeline not initialized");
    }

    // Truncate to ~512 tokens (rough estimate: 4 chars per token)
    const maxChars = 512 * 4;
    const truncated = text.length > maxChars ? text.slice(0, maxChars) : text;

    // Get embeddings - output is a Tensor with shape [1, seq_len, dim]
    const output = await this.pipeline(truncated, {
      pooling: "mean",
      normalize: true,
    });

    // Convert to flat array
    const data = output.data;
    const result: number[] = [];
    for (let i = 0; i < this.dim; i++) {
      result.push(data[i] ?? 0);
    }

    return result;
  }
}

/**
 * Factory function to create an embedding provider with fallback.
 * Returns TransformerEmbedding if available, otherwise HashEmbedding.
 */
export async function createEmbeddingProvider(
  type: "hash" | "transformer",
  dim: number,
  modelName?: string,
  logger?: { warn: (msg: string) => void },
): Promise<EmbeddingProvider> {
  if (type === "hash") {
    return new HashEmbedding(dim);
  }

  // Try transformer, fall back to hash
  const transformer = new TransformerEmbedding(modelName);
  try {
    await transformer.init();
    return transformer;
  } catch (err) {
    logger?.warn(`TransformerEmbedding failed, falling back to HashEmbedding: ${String(err)}`);
    return new HashEmbedding(dim);
  }
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s@.+-]/gu, " ")
    .trim();
}

function charNgrams(text: string, n: number): string[] {
  if (!text) {
    return [];
  }
  if (text.length <= n) {
    return [text];
  }
  const padded = ` ${text} `;
  const out: string[] = [];
  for (let i = 0; i <= padded.length - n; i++) {
    out.push(padded.slice(i, i + n));
  }
  return out;
}
