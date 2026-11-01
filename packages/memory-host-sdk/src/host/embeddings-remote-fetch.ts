import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { extractEmbeddingUsage } from "../../../llm-core/src/usage-cost.js";
import { resolveAzureApiVersionRequestTarget } from "./azure-api-version-request.js";
import { readEmbeddingVectors } from "./embedding-vectors.js";
import {
  addEmbeddingErrorContext,
  debugEmbeddingsLog,
  embeddingResponseLogMeta,
} from "./embeddings-debug.js";
import type { EmbeddingProviderCallOptions } from "./embeddings.types.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { postJson } from "./post-json.js";
import type { RemoteEmbeddingRequestAuth } from "./remote-http.js";

/** POST an embedding request and return validated vectors in request order. */
export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  resolveRequestHeaders?: RemoteEmbeddingRequestAuth;
  signal?: AbortSignal;
  onUsage?: EmbeddingProviderCallOptions["onUsage"];
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  const body = asOptionalRecord(params.body);
  const inputCount = Array.isArray(body?.input) ? body.input.length : undefined;
  const model = typeof body?.model === "string" ? body.model : "unknown";
  const errorPrefix = `${params.errorPrefix} (model: ${model}, batch size: ${inputCount ?? "unknown"})`;
  const context = { context: errorPrefix, inputCount };
  debugEmbeddingsLog("memory embeddings: remote request", context);
  const target = resolveAzureApiVersionRequestTarget(params);
  return await postJson({
    ...params,
    ...target,
    mapResponseError: (error) => addEmbeddingErrorContext(error, params.errorPrefix, errorPrefix),
    onResponse: (res) => {
      debugEmbeddingsLog("memory embeddings: remote response", {
        ...context,
        ...embeddingResponseLogMeta(res),
      });
    },
    parse: (payload) => {
      const data = asOptionalRecord(payload)?.data;
      const vectors = readEmbeddingVectors(data, inputCount, errorPrefix);
      params.onUsage?.(extractEmbeddingUsage(payload));
      return vectors;
    },
  });
}
