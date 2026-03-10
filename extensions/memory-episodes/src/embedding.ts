/**
 * Ollama Embedding Client
 *
 * Uses the Ollama REST API for local embeddings (no external API keys).
 */

export type EmbeddingConfig = {
  baseUrl: string;
  model: string;
  dimensions: number;
};

type OllamaEmbedResponse = {
  embeddings: number[][];
  error?: string;
};

// nomic-embed-text supports 8192 tokens; ~4 chars/token → ~30K char safety limit
const MAX_EMBED_CHARS = 30_000;

export async function embed(text: string, config: EmbeddingConfig): Promise<number[]> {
  const input = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;

  const response = await fetch(`${config.baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input,
      options: { num_ctx: 8192 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama embedding error ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as OllamaEmbedResponse;
  if (data.error) {
    throw new Error(`Ollama embedding error: ${data.error}`);
  }
  if (!data.embeddings?.[0]) {
    throw new Error("Ollama returned no embedding data");
  }

  return data.embeddings[0];
}
