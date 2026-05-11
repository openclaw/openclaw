/**
 * Embedding provider for any local OpenAI-compatible HTTP server.
 *
 * Targets self-hosted servers that speak OpenAI's `/v1/embeddings` shape:
 * llama.cpp's `llama-server`, Ollama (with its `/v1` surface), vLLM, TGI,
 * LocalAI, llamafile, or any reverse-proxied internal instance. The name
 * "openai-compatible" matches the term those projects use to describe
 * themselves.
 *
 * Key design choice: there is no warmup, no preload, and no model-load
 * probe. The first real `/v1/embeddings` call loads the model lazily, which
 * is what every server in this family already does. Skipping the warmup is
 * what lets this provider work against servers that do not implement any
 * vendor-specific "load model" endpoint.
 *
 * Distinct from the in-process `local` adapter
 * (`extensions/memory-core/src/memory/provider-adapters.ts`), which uses
 * `node-llama-cpp` and reads a `.gguf` file off disk with `transport:
 * "local"`. This adapter is purely HTTP and uses `transport: "remote"`.
 *
 * Config required (under the per-plugin `embedding` block):
 *   - baseUrl: full URL to the server's OpenAI-compatible base (e.g.
 *     "http://localhost:8081/v1")
 *   - model:   the model identifier the server expects in request bodies
 *
 * Config optional:
 *   - apiKey:  Bearer token if the server enforces one (llama-server with
 *              --api-key, LocalAI with API_KEY, etc.). Plain string or a
 *              SecretInput reference. Omitted when the server is open.
 *   - headers: additional HTTP headers to attach to every request.
 *
 * The provider does not consult any global `models.providers.*` block.
 * It is fully self-contained so it never accidentally inherits real
 * OpenAI cloud credentials when an operator also has chat models pointed
 * at api.openai.com.
 */
import {
  buildRemoteBaseUrlPolicy,
  createRemoteEmbeddingProvider,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySecretInputString } from "openclaw/plugin-sdk/memory-core-host-secret";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

export type OpenAICompatibleEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

/**
 * Build the request headers. We attach Authorization only when an API key
 * was supplied; servers that ignore auth (e.g. a default `ollama serve`)
 * stay header-clean so they are not mistakenly probed for auth flows.
 */
function buildHeaders(params: {
  apiKey: string | undefined;
  extra: Record<string, string> | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...params.extra,
  };
  if (params.apiKey && params.apiKey.length > 0) {
    headers.authorization = `Bearer ${params.apiKey}`;
  }
  return headers;
}

export async function createOpenAICompatibleEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: OpenAICompatibleEmbeddingClient }> {
  const baseUrl = options.remote?.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      "openai-compatible embeddings: missing baseUrl. Set the per-plugin `embedding.baseUrl` to your local OpenAI-compatible server (e.g. http://localhost:8081/v1).",
    );
  }
  const model = options.model?.trim();
  if (!model) {
    throw new Error(
      "openai-compatible embeddings: missing model. Set the per-plugin `embedding.model` to the identifier your server expects (e.g. text-embedding-bge-m3).",
    );
  }

  const apiKey = resolveMemorySecretInputString({
    value: options.remote?.apiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  })?.trim();

  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const headers = buildHeaders({
    apiKey,
    extra: options.remote?.headers,
  });

  const client: OpenAICompatibleEmbeddingClient = { baseUrl, headers, ssrfPolicy, model };

  return {
    provider: createRemoteEmbeddingProvider({
      id: OPENAI_COMPATIBLE_PROVIDER_ID,
      client,
      errorPrefix: "openai-compatible embeddings failed",
    }),
    client,
  };
}
