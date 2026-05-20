import type { EmbeddingProviderOptions } from "./embeddings.types.js";
import { requireApiKey, resolveApiKeyForProvider } from "./openclaw-runtime-auth.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";
import type { SsrFPolicy } from "./ssrf-policy.js";
import { normalizeOptionalString } from "./string-utils.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export type RemoteEmbeddingProviderId = string;

function resolveOpenClawAttributionHeaders(): Record<string, string> {
  const version = typeof process !== "undefined" ? process.env.OPENCLAW_VERSION?.trim() : undefined;
  return {
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": version ? `openclaw/${version}` : "openclaw",
  };
}

function isNativeOpenAIEmbeddingRoute(provider: string, baseUrl: string): boolean {
  if (provider !== "openai") {
    return false;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com";
  } catch {
    return false;
  }
}

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy }> {
  const remote = params.options.remote;
  const remoteApiKey = resolveMemorySecretInputString({
    value: remote?.apiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
  const remoteBaseUrl = normalizeOptionalString(remote?.baseUrl);
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  const baseUrl =
    remoteBaseUrl || normalizeOptionalString(providerConfig?.baseUrl) || params.defaultBaseUrl;
  const apiKey = remoteApiKey
    ? remoteApiKey
    : await resolveEmbeddingApiKey({
        provider: params.provider,
        baseUrl,
        config: params.options.config,
        agentDir: params.options.agentDir,
      });
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  if (isNativeOpenAIEmbeddingRoute(params.provider, baseUrl)) {
    Object.assign(headers, resolveOpenClawAttributionHeaders());
  }
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}

/**
 * Resolve an API key for embedding use. When the provider is "openai" and the
 * target is the native OpenAI API (api.openai.com), falls back to "openai-codex"
 * credentials if no direct "openai" API key is available. This allows users who
 * authenticate via `openclaw codex login` (OAuth) to use the same credential for
 * OpenAI embedding calls without setting a separate OPENAI_API_KEY.
 *
 * The fallback is intentionally narrow: it only fires for native OpenAI embedding
 * routes, preventing Codex OAuth tokens from leaking to custom baseUrl endpoints.
 */
async function resolveEmbeddingApiKey(params: {
  provider: string;
  baseUrl: string;
  config: EmbeddingProviderOptions["config"];
  agentDir?: string;
}): Promise<string> {
  try {
    return requireApiKey(
      await resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.config,
        agentDir: params.agentDir,
      }),
      params.provider,
    );
  } catch (directError) {
    // Narrow fallback: only try openai-codex for native OpenAI embedding routes.
    // This prevents Codex OAuth tokens from leaking to custom baseUrl endpoints.
    if (
      params.provider === "openai" &&
      isNativeOpenAIEmbeddingRoute(params.provider, params.baseUrl)
    ) {
      try {
        return requireApiKey(
          await resolveApiKeyForProvider({
            provider: OPENAI_CODEX_PROVIDER_ID,
            cfg: params.config,
            agentDir: params.agentDir,
          }),
          OPENAI_CODEX_PROVIDER_ID,
        );
      } catch {
        // Fall through to rethrow original error with better context
      }
    }
    throw directError;
  }
}
