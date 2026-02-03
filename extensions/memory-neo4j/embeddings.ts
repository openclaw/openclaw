/**
 * OpenAI embedding generation for memory-neo4j.
 *
 * Thin wrapper around the OpenAI embeddings API.
 * Uses text-embedding-3-small (1536 dims) by default.
 */

import OpenAI from "openai";

export class Embeddings {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string = "text-embedding-3-small",
  ) {
    this.client = new OpenAI({ apiKey });
  }

  /**
   * Generate an embedding vector for a single text.
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  /**
   * Generate embeddings for multiple texts in a single API call.
   * Returns array of embeddings in the same order as input.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    // Sort by index to ensure correct order
    return response.data.toSorted((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
