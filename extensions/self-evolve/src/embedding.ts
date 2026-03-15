import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { SelfEvolveConfig } from "./types.js";

export type EmbeddingAdapter = {
  name: string;
  embed: (text: string) => Promise<number[]>;
};

class HashEmbeddingAdapter implements EmbeddingAdapter {
  public readonly name = "hash";

  constructor(private readonly dimensions: number) {}

  async embed(text: string): Promise<number[]> {
    const values = Array.from({ length: this.dimensions }).fill(0) as number[];
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length > 0)
      .slice(0, 512);
    if (tokens.length === 0) {
      return values;
    }
    for (const token of tokens) {
      const hash = createHash("sha256").update(token).digest();
      const index = hash.readUInt16BE(0) % this.dimensions;
      values[index] += 1;
    }
    const norm = Math.sqrt(values.reduce((acc, value) => acc + value * value, 0));
    if (norm <= 0) {
      return values;
    }
    return values.map((value) => value / norm);
  }
}

class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  public readonly name = "openai";
  private readonly client: OpenAI;

  constructor(
    private readonly model: string,
    apiKey: string,
    private readonly dimensions?: number,
    baseUrl?: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    });
    return response.data[0]?.embedding ?? [];
  }
}

export function createEmbeddingAdapter(config: SelfEvolveConfig): EmbeddingAdapter {
  if (config.embedding.provider === "openai" && config.embedding.apiKey) {
    return new OpenAIEmbeddingAdapter(
      config.embedding.model,
      config.embedding.apiKey,
      config.embedding.dimensions,
      config.embedding.baseUrl,
    );
  }
  return new HashEmbeddingAdapter(config.embedding.dimensions ?? 512);
}
