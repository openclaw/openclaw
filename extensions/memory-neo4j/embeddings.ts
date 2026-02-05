/**
 * Embedding generation for memory-neo4j.
 *
 * Supports both OpenAI and Ollama providers.
 */

import OpenAI from "openai";
import type { EmbeddingProvider } from "./config.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

export class Embeddings {
  private client: OpenAI | null = null;
  private readonly provider: EmbeddingProvider;
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string = "text-embedding-3-small",
    provider: EmbeddingProvider = "openai",
    baseUrl?: string,
    logger?: Logger,
  ) {
    this.provider = provider;
    this.baseUrl = baseUrl ?? (provider === "ollama" ? "http://localhost:11434" : "");
    this.logger = logger;

    if (provider === "openai") {
      if (!apiKey) {
        throw new Error("API key required for OpenAI embeddings");
      }
      this.client = new OpenAI({ apiKey });
    }
  }

  /**
   * Generate an embedding vector for a single text.
   */
  async embed(text: string): Promise<number[]> {
    if (this.provider === "ollama") {
      return this.embedOllama(text);
    }
    return this.embedOpenAI(text);
  }

  /**
   * Generate embeddings for multiple texts.
   * Returns array of embeddings in the same order as input.
   *
   * For Ollama: uses Promise.allSettled so individual failures don't break the
   * entire batch. Failed embeddings are replaced with zero vectors and logged.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    if (this.provider === "ollama") {
      // Ollama doesn't support batch, so we do sequential with resilient error handling
      const results = await Promise.allSettled(texts.map((t) => this.embedOllama(t)));
      const embeddings: number[][] = [];
      let failures = 0;

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          embeddings.push(result.value);
        } else {
          failures++;
          this.logger?.warn?.(
            `memory-neo4j: Ollama embedding failed for text ${i}: ${String(result.reason)}`,
          );
          // Use zero vector as placeholder so indices stay aligned
          embeddings.push([]);
        }
      }

      if (failures > 0) {
        this.logger?.warn?.(
          `memory-neo4j: ${failures}/${texts.length} Ollama embeddings failed in batch`,
        );
      }

      return embeddings;
    }

    return this.embedBatchOpenAI(texts);
  }

  private async embedOpenAI(text: string): Promise<number[]> {
    if (!this.client) {
      throw new Error("OpenAI client not initialized");
    }
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  private async embedBatchOpenAI(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error("OpenAI client not initialized");
    }
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    // Sort by index to ensure correct order
    return response.data.toSorted((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // Timeout for Ollama embedding fetch calls to prevent hanging indefinitely
  private static readonly EMBED_TIMEOUT_MS = 30_000;

  private async embedOllama(text: string): Promise<number[]> {
    const url = `${this.baseUrl}/api/embed`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
      signal: AbortSignal.timeout(Embeddings.EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embedding failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings?.[0]) {
      throw new Error("No embedding returned from Ollama");
    }
    return data.embeddings[0];
  }
}
