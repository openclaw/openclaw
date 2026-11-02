import {
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  asNonArrayRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";

export type PerplexityTransport = "search_api" | "chat_completions";
export type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};
export type PerplexityAuth = {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
};

export function resolvePerplexityWebSearchRuntimeMetadata(
  ctx: Parameters<NonNullable<WebSearchProviderPlugin["resolveRuntimeMetadata"]>>[0],
) {
  const credential = ctx.resolvedCredential;
  // Resolved SecretRefs use configured-key inference; env fallbacks own their endpoint.
  const source: PerplexityAuth["source"] =
    credential?.source === "env"
      ? credential.fallbackEnvVar === "PERPLEXITY_API_KEY"
        ? "perplexity_env"
        : "openrouter_env"
      : (credential?.source === "config" || credential?.source === "secretRef") && credential.value
        ? "config"
        : "none";
  return {
    perplexityTransport: resolvePerplexityRuntime(
      resolvePerplexityConfig(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "perplexity",
          resolveProviderWebSearchPluginConfig(ctx.config, "perplexity"),
        ),
      ),
      { apiKey: credential?.value, source },
    ).transport,
  };
}

export function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  return (
    normalizeLowercaseStringOrEmpty(URL.parse(baseUrl.trim())?.hostname) === "api.perplexity.ai"
  );
}

export function resolvePerplexityConfig(searchConfig?: Record<string, unknown>): PerplexityConfig {
  return asNonArrayRecord(searchConfig?.perplexity);
}

export function hasPerplexityLegacyOverride(perplexity?: PerplexityConfig): boolean {
  return Boolean(
    normalizeOptionalString(perplexity?.baseUrl) || normalizeOptionalString(perplexity?.model),
  );
}

export function resolvePerplexityRuntime(
  perplexity: PerplexityConfig | undefined,
  auth: PerplexityAuth,
): { apiKey?: string; baseUrl: string; model: string; transport: PerplexityTransport } {
  const baseUrl =
    normalizeOptionalString(perplexity?.baseUrl) ||
    (auth.source === "perplexity_env" ||
    (auth.source === "config" && !normalizeLowercaseStringOrEmpty(auth.apiKey).startsWith("sk-or-"))
      ? PERPLEXITY_DIRECT_BASE_URL
      : DEFAULT_PERPLEXITY_BASE_URL);
  return {
    apiKey: auth.apiKey,
    baseUrl,
    model: normalizeOptionalString(perplexity?.model) || DEFAULT_PERPLEXITY_MODEL,
    transport:
      hasPerplexityLegacyOverride(perplexity) || !isDirectPerplexityBaseUrl(baseUrl)
        ? "chat_completions"
        : "search_api",
  };
}
