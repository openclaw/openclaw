/**
 * Wrapper around the OpenAI embeddings API. Kept tiny so it can be swapped
 * for a different provider (Voyage, Cohere, local) by changing this file
 * only.
 */

import OpenAI from "openai";

export class Embeddings {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly dimensions: number,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });
    return response.data[0].embedding;
  }
}
