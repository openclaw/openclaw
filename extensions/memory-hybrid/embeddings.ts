/**
 * Embeddings Module
 *
 * Converts text into vector representations using OpenAI or Google embedding APIs.
 * Supports: OpenAI text-embedding-3-* and Google gemini-embedding-001.
 */

import OpenAI from "openai";
import { ApiRateLimiter, TaskPriority } from "./limiter.js";
import { type Logger } from "./tracer.js";
import { withRetry } from "./utils.js";

// Dimension map for supported models
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "gemini-embedding-001": 3072,
  "gemini-embedding-002": 3072,
  "text-embedding-004": 768,
  "gemini-embedding-2-preview": 3072,
};

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: "${model}". Supported: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}`,
    );
  }
  return dims;
}

export type EmbeddingProvider = "openai" | "google";

export function detectProvider(model: string): EmbeddingProvider {
  if (model.startsWith("text-embedding-3") || model.startsWith("text-embedding-ada")) {
    return "openai";
  }
  return "google";
}

export class Embeddings {
  private openai?: OpenAI;
  // Simple in-memory cache ("Myelination") to avoid redundant API calls
  private cache = new Map<string, number[]>();
  private readonly provider: EmbeddingProvider;
  private readonly maxCacheSize = 100;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly outputDim?: number,
    private readonly limiter?: ApiRateLimiter,
    private readonly logger?: Logger,
  ) {
    this.provider = detectProvider(model);
    if (this.provider === "openai") {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async embed(text: string, priority = TaskPriority.HIGH): Promise<number[]> {
    // Check cache first (LRU: delete+re-insert moves key to end of Map order)
    const cacheKey = `${this.model}:${text}`;
    if (this.cache.has(cacheKey)) {
      const val = this.cache.get(cacheKey)!;
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, val);
      return [...val]; // Return copy to prevent cache mutation
    }

    let vector: number[];
    if (this.provider === "openai") {
      if (this.limiter) {
        vector = await this.limiter.execute(() => this.embedOpenAI(text), priority, "embed_single");
      } else {
        vector = await this.embedOpenAI(text);
      }
    } else {
      // Pass dimension if supported (Matryoshka)
      const dims = this.outputDim ?? EMBEDDING_DIMENSIONS[this.model];

      if (this.limiter) {
        vector = await this.limiter.execute(
          () => this.embedGoogle(text, dims),
          priority,
          "embed_single",
        );
      } else {
        vector = await this.embedGoogle(text, dims);
      }
    }

    // Update cache
    if (this.cache.size >= this.maxCacheSize) {
      // Evict oldest (first key)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, vector);

    return vector;
  }

  async embedBatch(texts: string[], priority = TaskPriority.NORMAL): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Simple caching for batch: only embed what we need
    const results: number[][] = new Array(texts.length);
    const neededIndices: number[] = [];
    const neededTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cacheKey = `${this.model}:${texts[i]}`;
      if (this.cache.has(cacheKey)) {
        const val = this.cache.get(cacheKey)!;
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, val); // Move to LRU end
        results[i] = val;
      } else {
        neededIndices.push(i);
        neededTexts.push(texts[i]);
      }
    }

    if (neededTexts.length > 0) {
      let newVectors: number[][];
      if (this.provider === "openai") {
        if (this.limiter) {
          newVectors = await this.limiter.execute(
            () => this.embedOpenAIBatch(neededTexts),
            priority,
            "embed_batch",
          );
        } else {
          newVectors = await this.embedOpenAIBatch(neededTexts);
        }
      } else {
        const dims = this.outputDim ?? EMBEDDING_DIMENSIONS[this.model];
        if (this.limiter) {
          newVectors = await this.limiter.execute(
            () => this.embedGoogleBatch(neededTexts, dims),
            priority,
            "embed_batch",
          );
        } else {
          newVectors = await this.embedGoogleBatch(neededTexts, dims);
        }
      }

      for (let i = 0; i < neededTexts.length; i++) {
        const cacheKey = `${this.model}:${neededTexts[i]}`;
        if (this.cache.size >= this.maxCacheSize) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey) this.cache.delete(firstKey);
        }
        this.cache.set(cacheKey, newVectors[i]);
        results[neededIndices[i]] = newVectors[i];
      }
    }

    return results;
  }

  private async embedOpenAI(text: string): Promise<number[]> {
    return this.executeWithRetry(async () => {
      const response = await this.openai!.embeddings.create({
        model: this.model,
        input: text,
      });
      return response.data[0].embedding;
    });
  }

  private async embedOpenAIBatch(texts: string[]): Promise<number[][]> {
    return this.executeWithRetry(async () => {
      const response = await this.openai!.embeddings.create({
        model: this.model,
        input: texts,
      });
      return response.data.map((d) => d.embedding);
    });
  }

  private async embedGoogle(text: string, dimensions?: number): Promise<number[]> {
    return this.executeWithRetry(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`;

      const body: Record<string, unknown> = {
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      };

      if (dimensions) {
        body.outputDimensionality = dimensions;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const sanitizedError = errorBody.replaceAll(this.apiKey, "[REDACTED]");
        if (this.logger)
          this.logger.error(
            `[memory-hybrid][embeddings] Google Embedding API error (${response.status}): ${sanitizedError}`,
          );
        throw new Error(`Google Embedding API error (${response.status}): ${sanitizedError}`);
      }

      const data = (await response.json()) as {
        embedding?: { values?: number[] };
        error?: { message: string };
      };
      if (data.error) {
        if (this.logger)
          this.logger.error(
            `[memory-hybrid][embeddings] Google Embedding API error: ${data.error.message}`,
          );
        throw new Error(`Google Embedding API: ${data.error.message}`);
      }
      const values = data?.embedding?.values;

      if (!values || !Array.isArray(values)) {
        if (this.logger)
          this.logger.error(
            `[memory-hybrid][embeddings] Unexpected Google Embedding API response: ${JSON.stringify(data)}`,
          );
        throw new Error(`Unexpected Google Embedding API response: ${JSON.stringify(data)}`);
      }
      return values;
    });
  }

  private async embedGoogleBatch(texts: string[], dimensions?: number): Promise<number[][]> {
    return this.executeWithRetry(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`;

      const requests = texts.map((text) => {
        const req: Record<string, unknown> = {
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
        };
        if (dimensions) {
          req.outputDimensionality = dimensions;
        }
        return req;
      });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({ requests }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const sanitizedError = errorBody.replaceAll(this.apiKey, "[REDACTED]");
        if (this.logger)
          this.logger.error(
            `[memory-hybrid][embeddings] Google Batch Embedding API error (${response.status}): ${sanitizedError}`,
          );
        throw new Error(`Google Batch Embedding API error (${response.status}): ${sanitizedError}`);
      }

      const data = (await response.json()) as {
        embeddings?: Array<{ values?: number[] }>;
        error?: { message: string };
      };
      if (data.error) {
        if (this.logger)
          this.logger.error(
            `[memory-hybrid][embeddings] Google Batch Embedding API error: ${data.error.message}`,
          );
        throw new Error(`Google Batch Embedding API: ${data.error.message}`);
      }
      const embeddings = data?.embeddings;

      if (!embeddings || !Array.isArray(embeddings)) {
        throw new Error(`Unexpected Google Batch Embedding API response: ${JSON.stringify(data)}`);
      }
      return embeddings.map((e) => e.values ?? []);
    });
  }

  /**
   * Internal wrapper for retry logic.
   */
  private async executeWithRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    return withRetry(fn, maxRetries);
  }
}
