/**
 * Embeddings Module
 *
 * Converts text into vector representations using OpenAI or Google embedding APIs.
 * Supports: OpenAI text-embedding-3-* and Google gemini-embedding-001.
 */

import OpenAI from "openai";
import { withRetry } from "./utils.js";

// Dimension map for supported models
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "gemini-embedding-001": 3072,
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
  if (
    model.startsWith("text-embedding-3") ||
    model.startsWith("text-embedding-ada") ||
    model === "text-embedding-004"
  ) {
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
    private readonly outputDimensionality?: number,
  ) {
    this.provider = detectProvider(model);
    if (this.provider === "openai") {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async embed(text: string): Promise<number[]> {
    // Check cache first (LRU: delete+re-insert moves key to end of Map order)
    const cacheKey = `${this.model}:${text}`;
    if (this.cache.has(cacheKey)) {
      const val = this.cache.get(cacheKey)!;
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, val);
      return val;
    }

    let vector: number[];
    if (this.provider === "openai") {
      vector = await this.embedOpenAI(text);
    } else {
      // Pass dimension if supported (Matryoshka)
      const dims = this.outputDimensionality ?? EMBEDDING_DIMENSIONS[this.model];
      vector = await this.embedGoogle(text, dims);
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

  async embedBatch(texts: string[]): Promise<number[][]> {
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
        newVectors = await this.embedOpenAIBatch(neededTexts);
      } else {
        const dims = this.outputDimensionality ?? EMBEDDING_DIMENSIONS[this.model];
        newVectors = await this.embedGoogleBatch(neededTexts, dims);
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
    return this.withRetry(async () => {
      const response = await this.openai!.embeddings.create({
        model: this.model,
        input: text,
      });
      return response.data[0].embedding;
    });
  }

  private async embedOpenAIBatch(texts: string[]): Promise<number[][]> {
    return this.withRetry(async () => {
      const response = await this.openai!.embeddings.create({
        model: this.model,
        input: texts,
      });
      return response.data.map((d) => d.embedding);
    });
  }

  private async embedGoogle(text: string, dimensions?: number): Promise<number[]> {
    return this.withRetry(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;

      const body: any = {
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      };

      if (dimensions) {
        body.outputDimensionality = dimensions;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const sanitizedError = errorBody.replace(this.apiKey, "[REDACTED]");
        throw new Error(`Google Embedding API error (${response.status}): ${sanitizedError}`);
      }

      const data = (await response.json()) as { embedding?: { values?: number[] } };
      const values = data?.embedding?.values;

      if (!values || !Array.isArray(values)) {
        throw new Error(`Unexpected Google Embedding API response: ${JSON.stringify(data)}`);
      }
      return values;
    });
  }

  private async embedGoogleBatch(texts: string[], dimensions?: number): Promise<number[][]> {
    return this.withRetry(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;

      const requests = texts.map((text) => {
        const req: any = {
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const sanitizedError = errorBody.replace(this.apiKey, "[REDACTED]");
        throw new Error(`Google Batch Embedding API error (${response.status}): ${sanitizedError}`);
      }

      const data = (await response.json()) as { embeddings?: Array<{ values?: number[] }> };
      const embeddings = data?.embeddings;

      if (!embeddings || !Array.isArray(embeddings)) {
        throw new Error(`Unexpected Google Batch Embedding API response: ${JSON.stringify(data)}`);
      }
      return embeddings.map((e) => e.values ?? []);
    });
  }

  /**
   * Retry with exponential backoff (delegates to shared utility).
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    return withRetry(fn, maxRetries);
  }
}
