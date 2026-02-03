/**
 * OpenAI Embeddings wrapper for docs-chat RAG pipeline.
 * Provides single and batch embedding generation.
 */
import OpenAI from "openai";

const DEFAULT_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

// OpenAI allows up to 2048 inputs per batch, but we use smaller batches for reliability
const MAX_BATCH_SIZE = 100;

export class Embeddings {
  private client: OpenAI;
  private model: string;
  public readonly dimensions: number;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for embeddings");
    }
    const dims = EMBEDDING_DIMENSIONS[model];
    if (!dims) {
      throw new Error(`Unsupported embedding model: ${model}`);
    }
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dimensions = dims;
  }

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  /**
   * Generate embeddings for multiple texts in batches.
   * Returns embeddings in the same order as input texts.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];

    // Process in batches to avoid API limits
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
      });
      // Ensure order is preserved (API returns in same order)
      const batchEmbeddings = response.data.map((d) => d.embedding);
      results.push(...batchEmbeddings);
    }

    return results;
  }
}
