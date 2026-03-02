/**
 * Embeddings Module
 *
 * Converts text into vector representations using OpenAI or Google embedding APIs.
 * Supports: OpenAI text-embedding-3-* and Google gemini-embedding-001.
 */

import OpenAI from "openai";

// Dimension map for supported models
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "gemini-embedding-001": 3072,
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
  private readonly maxCacheSize = 100;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly provider: EmbeddingProvider,
  ) {
    if (this.provider === "openai") {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async embed(text: string): Promise<number[]> {
    // Check cache first (Myelination: rapid recall)
    const cacheKey = `${this.model}:${this.provider}:${text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let vector: number[];
    if (this.provider === "openai") {
      vector = await this.embedOpenAI(text);
    } else {
      vector = await this.embedGoogle(text);
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

  private async embedOpenAI(text: string): Promise<number[]> {
    return this.withRetry(async () => {
      const response = await this.openai!.embeddings.create({
        model: this.model,
        input: text,
      });
      return response.data[0].embedding;
    });
  }

  private async embedGoogle(text: string): Promise<number[]> {
    return this.withRetry(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Google Embedding API error (${response.status}): ${errorBody}`);
      }

      const data = (await response.json()) as { embedding?: { values?: number[] } };
      const values = data?.embedding?.values;

      if (!values || !Array.isArray(values)) {
        throw new Error(`Unexpected Google Embedding API response: ${JSON.stringify(data)}`);
      }
      return values;
    });
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        const msg = String(err);
        const isRateLimit =
          msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("rate limit");

        if (i === maxRetries - 1 || !isRateLimit) throw err;

        // Exponential backoff: 1s, 2s, 4s
        const delay = 1000 * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Unreachable");
  }
}
