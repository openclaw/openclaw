/**
 * Embedding generation for memory-neo4j.
 *
 * Supports both OpenAI and Ollama providers.
 * Includes an LRU cache to avoid redundant API calls within a session.
 */

import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { EmbeddingProvider } from "./config.js";
import type { Logger } from "./schema.js";
import { contextLengthForModel } from "./config.js";

/**
 * Simple LRU cache for embedding vectors.
 * Keyed by SHA-256 hash of the input text to avoid storing large strings.
 */
class EmbeddingCache {
  private readonly map = new Map<string, number[]>();
  private readonly maxSize: number;

  constructor(maxSize: number = 200) {
    this.maxSize = maxSize;
  }

  private static hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  get(text: string): number[] | undefined {
    const key = EmbeddingCache.hashText(text);
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used) by re-inserting
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(text: string, embedding: number[]): void {
    const key = EmbeddingCache.hashText(text);
    // If key exists, delete first to refresh position
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first) entry
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, embedding);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Default concurrency for Ollama embedding requests */
const OLLAMA_EMBED_CONCURRENCY = 4;

export class Embeddings {
  private client: OpenAI | null = null;
  private readonly provider: EmbeddingProvider;
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;
  private readonly contextLength: number;
  private readonly cache = new EmbeddingCache(200);

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string = "text-embedding-3-small",
    provider: EmbeddingProvider = "openai",
    baseUrl?: string,
    logger?: Logger,
  ) {
    this.provider = provider;
    this.baseUrl = (baseUrl ?? (provider === "ollama" ? "http://localhost:11434" : "")).replace(
      /\/+$/,
      "",
    );
    this.logger = logger;
    this.contextLength = contextLengthForModel(model);

    if (provider === "openai") {
      if (!apiKey) {
        throw new Error("API key required for OpenAI embeddings");
      }
      this.client = new OpenAI({ apiKey });
    }
  }

  /**
   * Truncate text to fit within the model's context length.
   * Uses a conservative ~3 chars/token estimate to leave headroom —
   * code, URLs, and punctuation-heavy text tokenize at 1–2 chars/token,
   * so the classic ~4 estimate is too generous for mixed content.
   * Truncates at a word boundary when possible.
   */
  private truncateToContext(text: string): string {
    const maxChars = this.contextLength * 3;
    if (text.length <= maxChars) {
      return text;
    }

    // Try to truncate at a word boundary
    let truncated = text.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.8) {
      truncated = truncated.slice(0, lastSpace);
    }

    this.logger?.debug?.(
      `memory-neo4j: truncated embedding input from ${text.length} to ${truncated.length} chars (model context: ${this.contextLength} tokens)`,
    );
    return truncated;
  }

  /**
   * Generate an embedding vector for a single text.
   * Results are cached to avoid redundant API calls.
   */
  async embed(text: string): Promise<number[]> {
    const input = this.truncateToContext(text);

    // Check cache first
    const cached = this.cache.get(input);
    if (cached) {
      this.logger?.debug?.("memory-neo4j: embedding cache hit");
      return cached;
    }

    const embedding =
      this.provider === "ollama" ? await this.embedOllama(input) : await this.embedOpenAI(input);

    this.cache.set(input, embedding);
    return embedding;
  }

  /**
   * Generate embeddings for multiple texts.
   * Returns array of embeddings in the same order as input.
   *
   * For Ollama: processes in chunks of OLLAMA_EMBED_CONCURRENCY to avoid
   * overwhelming the local server. Individual failures don't break the
   * entire batch — failed embeddings are replaced with empty arrays.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const truncated = texts.map((t) => this.truncateToContext(t));

    // Check cache for each text; only compute uncached ones
    const results: (number[] | null)[] = truncated.map((t) => this.cache.get(t) ?? null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        uncachedIndices.push(i);
        uncachedTexts.push(truncated[i]);
      }
    }

    if (uncachedTexts.length === 0) {
      this.logger?.debug?.(`memory-neo4j: embedBatch fully cached (${texts.length} texts)`);
      return results as number[][];
    }

    let computed: number[][];

    if (this.provider === "ollama") {
      computed = await this.embedBatchOllama(uncachedTexts);
    } else {
      computed = await this.embedBatchOpenAI(uncachedTexts);
    }

    // Merge computed results back and populate cache
    for (let i = 0; i < uncachedIndices.length; i++) {
      const embedding = computed[i];
      results[uncachedIndices[i]] = embedding;
      if (embedding.length > 0) {
        this.cache.set(uncachedTexts[i], embedding);
      }
    }

    return results as number[][];
  }

  /**
   * Ollama batch embedding with concurrency limiting.
   * Processes in chunks to avoid overwhelming the server.
   */
  private async embedBatchOllama(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    let failures = 0;

    // Process in chunks of OLLAMA_EMBED_CONCURRENCY
    for (let i = 0; i < texts.length; i += OLLAMA_EMBED_CONCURRENCY) {
      const chunk = texts.slice(i, i + OLLAMA_EMBED_CONCURRENCY);
      const chunkResults = await Promise.allSettled(chunk.map((t) => this.embedOllama(t)));

      for (let j = 0; j < chunkResults.length; j++) {
        const result = chunkResults[j];
        if (result.status === "fulfilled") {
          embeddings.push(result.value);
        } else {
          failures++;
          this.logger?.warn?.(
            `memory-neo4j: Ollama embedding failed for text ${i + j}: ${String(result.reason)}`,
          );
          // Use empty array as placeholder so indices stay aligned
          embeddings.push([]);
        }
      }
    }

    if (failures > 0) {
      this.logger?.warn?.(
        `memory-neo4j: ${failures}/${texts.length} Ollama embeddings failed in batch`,
      );
    }

    return embeddings;
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
    return [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // Timeout for Ollama embedding fetch calls to prevent hanging indefinitely
  private static readonly EMBED_TIMEOUT_MS = 30_000;
  // Retry configuration for transient Ollama errors (model loading, GPU pressure)
  private static readonly OLLAMA_MAX_RETRIES = 2;
  private static readonly OLLAMA_RETRY_BASE_DELAY_MS = 1000;

  private async embedOllama(text: string): Promise<number[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= Embeddings.OLLAMA_MAX_RETRIES; attempt++) {
      try {
        return await this.fetchOllamaEmbedding(text);
      } catch (err) {
        lastError = err;
        if (attempt < Embeddings.OLLAMA_MAX_RETRIES) {
          const delay = Embeddings.OLLAMA_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          this.logger?.warn?.(
            `memory-neo4j: Ollama embedding failed (attempt ${attempt + 1}/${Embeddings.OLLAMA_MAX_RETRIES + 1}), retrying in ${delay}ms: ${String(err)}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  private async fetchOllamaEmbedding(text: string): Promise<number[]> {
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

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal).
 * Returns 0 if either vector is empty or they differ in length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
