import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { EmbeddingUsage } from "../../../../src/plugins/embedding-provider-types.js";
import { readEmbeddingVectors } from "./embedding-vectors.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { postJson } from "./post-json.js";

// Fetches and validates OpenAI-compatible embedding responses.

/** Extract OpenAI-style `usage` ({ prompt_tokens, total_tokens }) from an embedding payload. */
export function extractEmbeddingUsage(payload: unknown): EmbeddingUsage | undefined {
  const usage = asOptionalRecord(asOptionalRecord(payload)?.usage);
  if (!usage) {
    return undefined;
  }
  const promptTokens = normalizeUsageCount(usage.prompt_tokens);
  const totalTokens = normalizeUsageCount(usage.total_tokens);
  if (promptTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  // Embedding calls bill prompt tokens only; mirror one count when a provider
  // reports just one side.
  return {
    promptTokens: promptTokens ?? totalTokens ?? 0,
    totalTokens: totalTokens ?? promptTokens ?? 0,
  };
}

function normalizeUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** POST an embedding request and return validated vectors with provider-reported usage. */
export async function fetchRemoteEmbeddingVectorsDetailed(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
}): Promise<{ vectors: number[][]; usage?: EmbeddingUsage }> {
  return await postJson({
    url: params.url,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    body: params.body,
    errorPrefix: params.errorPrefix,
    parse: (payload) => {
      const input = asOptionalRecord(params.body)?.input;
      return {
        vectors: readEmbeddingVectors(
          asOptionalRecord(payload)?.data,
          Array.isArray(input) ? input.length : undefined,
          params.errorPrefix,
        ),
        usage: extractEmbeddingUsage(payload),
      };
    },
  });
}

/** POST an embedding request and return validated vectors in request order. */
export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  return (await fetchRemoteEmbeddingVectorsDetailed(params)).vectors;
}
