import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readEmbeddingVectors } from "./embedding-vectors.js";
import {
  addEmbeddingErrorContext,
  debugEmbeddingsLog,
  embeddingResponseLogMeta,
} from "./embeddings-debug.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { postJson } from "./post-json.js";

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
  const body = asOptionalRecord(params.body);
  const inputCount = Array.isArray(body?.input) ? body.input.length : undefined;
  const model = typeof body?.model === "string" ? body.model : "unknown";
  const errorPrefix = `${params.errorPrefix} (model: ${model}, batch size: ${inputCount ?? "unknown"})`;
  const context = { context: errorPrefix, inputCount };
  debugEmbeddingsLog("memory embeddings: remote request", context);
  return await postJson({
    ...params,
    mapResponseError: (error) => addEmbeddingErrorContext(error, params.errorPrefix, errorPrefix),
    onResponse: (res) => {
      debugEmbeddingsLog("memory embeddings: remote response", {
        ...context,
        ...embeddingResponseLogMeta(res),
      });
    },
    parse: (payload) => {
      const data = asOptionalRecord(payload)?.data;
      return readEmbeddingVectors(data, inputCount, errorPrefix);
    },
  });
}
