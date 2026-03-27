import { Type } from "@sinclair/typebox";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  getScopedCredentialValue,
  normalizeCacheKey,
  readCache,
  readNumberParam,
  readStringParam,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  resolveWebSearchProviderCredential,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  requestXaiWebSearch,
  resolveXaiInlineCitations,
  resolveXaiWebSearchModel,
} from "./src/web-search-shared.js";

const XAI_WEB_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

function runXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `grok:${params.model}:${String(params.inlineCitations)}:${params.query}`,
  );
  const cached = readCache(XAI_WEB_SEARCH_CACHE, cacheKey);
  if (cached) {
    return Promise.resolve({ ...cached.value, cached: true });
  }

  return (async () => {
    const startedAt = Date.now();
    const result = await requestXaiWebSearch({
      query: params.query,
      model: params.model,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.inlineCitations,
    });
    const payload = buildXaiWebSearchPayload({
      query: params.query,
      provider: "grok",
      model: params.model,
      tookMs: Date.now() - startedAt,
      content: result.content,
      citations: result.citations,
      inlineCitations: result.inlineCitations,
    });

    writeCache(XAI_WEB_SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  })();
}

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "Requires xAI API key · xAI web-grounded responses",
    onboardingScopes: ["text-inference"],
    credentialLabel: "xAI API key",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig?: Record<string, unknown>) =>
      getScopedCredentialValue(searchConfig, "grok"),
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) =>
      setScopedCredentialValue(searchConfigTarget, "grok", value),
    createTool: (ctx: { searchConfig?: Record<string, unknown> }) => ({
      description:
        "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string." }),
        count: Type.Optional(
          Type.Number({
            description: "Number of results to return (1-10).",
            minimum: 1,
            maximum: 10,
          }),
        ),
      }),
      execute: async (args: Record<string, unknown>) => {
        const apiKey = resolveWebSearchProviderCredential({
          credentialValue: getScopedCredentialValue(ctx.searchConfig, "grok"),
          path: "tools.web.search.grok.apiKey",
          envVars: ["XAI_API_KEY"],
        });

        if (!apiKey) {
          return {
            error: "missing_xai_api_key",
            message:
              "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }

        const query = readStringParam(args, "query", { required: true });
        void readNumberParam(args, "count", { integer: true });

        return await runXaiWebSearch({
          query,
          model: resolveXaiWebSearchModel(ctx.searchConfig),
          apiKey,
          timeoutSeconds: resolveTimeoutSeconds(
            (ctx.searchConfig?.timeoutSeconds as number | undefined) ?? undefined,
            DEFAULT_TIMEOUT_SECONDS,
          ),
          inlineCitations: resolveXaiInlineCitations(ctx.searchConfig),
          cacheTtlMs: resolveCacheTtlMs(
            (ctx.searchConfig?.cacheTtlMinutes as number | undefined) ?? undefined,
            DEFAULT_CACHE_TTL_MINUTES,
          ),
        });
      },
    }),
  };
}

export const __testing = {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiWebSearchModel,
  requestXaiWebSearch,
};
