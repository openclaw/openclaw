import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readEmbeddingVectors } from "./embedding-vectors.js";
import type { EmbeddingProviderCallOptions, EmbeddingUsage } from "./embeddings.types.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { postJson } from "./post-json.js";

// Fetches and validates OpenAI-compatible embedding responses.

export function extractEmbeddingUsage(payload: unknown): EmbeddingUsage | undefined {
  const usage = asOptionalRecord(asOptionalRecord(payload)?.usage);
  const promptTokens = normalizeUsageCount(usage?.prompt_tokens);
  const totalTokens = normalizeUsageCount(usage?.total_tokens);
  if (promptTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  // Embeddings bill input tokens only; providers may report just one of these fields.
  return {
    promptTokens: promptTokens ?? totalTokens ?? 0,
    totalTokens: totalTokens ?? promptTokens ?? 0,
  };
}

function normalizeUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** POST an embedding request and return validated vectors in request order. */
export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onUsage?: EmbeddingProviderCallOptions["onUsage"];
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  return await postJson({
    ...params,
    parse: (payload) => {
      const input = asOptionalRecord(params.body)?.input;
      const vectors = readEmbeddingVectors(
        asOptionalRecord(payload)?.data,
        Array.isArray(input) ? input.length : undefined,
        params.errorPrefix,
      );
      params.onUsage?.(extractEmbeddingUsage(payload));
      return vectors;
    },
  });
}
