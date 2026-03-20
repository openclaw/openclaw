import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";

type GrokConfig = {
  apiKey?: string;
  model?: string;
  inlineCitations?: boolean;
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

function resolveGrokConfig(searchConfig?: SearchConfigRecord): GrokConfig {
  const grok = searchConfig?.grok;
  return grok && typeof grok === "object" && !Array.isArray(grok) ? (grok as GrokConfig) : {};
}

function resolveGrokApiKey(grok?: GrokConfig): string | undefined {
  return (
    readConfiguredSecretString(grok?.apiKey, "tools.web.search.grok.apiKey") ??
    readProviderEnvValue(["XAI_API_KEY"])
  );
}

function resolveGrokModel(grok?: GrokConfig): string {
  const model = typeof grok?.model === "string" ? grok.model.trim() : "";
  return model || DEFAULT_GROK_MODEL;
}

function resolveGrokInlineCitations(grok?: GrokConfig): boolean {
  return grok?.inlineCitations === true;
}

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter(
              (annotation) =>
                annotation.type === "url_citation" && typeof annotation.url === "string",
            )
            .map((annotation) => annotation.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }
    if (output.type === "output_text" && typeof output.text === "string" && output.text) {
      const urls = (Array.isArray(output.annotations) ? output.annotations : [])
        .filter(
          (annotation) => annotation.type === "url_citation" && typeof annotation.url === "string",
        )
        .map((annotation) => annotation.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }

  return {
    text: typeof data.output_text === "string" ? data.output_text : undefined,
    annotationCitations: [],
  };
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  return withTrustedWebSearchEndpoint(
    {
      url: XAI_API_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          input: [{ role: "user", content: params.query }],
          tools: [{ type: "web_search" }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`xAI API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as GrokSearchResponse;
      const { text, annotationCitations } = extractGrokContent(data);
      return {
        content: text ?? "No response",
        citations: (data.citations ?? []).length > 0 ? data.citations! : annotationCitations,
        inlineCitations: data.inline_citations,
      };
    },
  );
}

function createGrokSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    language: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Grok." })),
  });
}

function createGrokToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
    parameters: createGrokSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const unsupportedResponse = buildUnsupportedSearchFilterResponse(params, "grok");
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      const grokConfig = resolveGrokConfig(searchConfig);
      const apiKey = resolveGrokApiKey(grokConfig);
      if (!apiKey) {
        return {
          error: "missing_xai_api_key",
          message:
            "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const model = resolveGrokModel(grokConfig);
      const inlineCitations = resolveGrokInlineCitations(grokConfig);
      const cacheKey = buildSearchCacheKey([
        "grok",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        model,
        inlineCitations,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runGrokSearch({
        query,
        apiKey,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        inlineCitations,
      });
      const payload = {
        query,
        provider: "grok",
        model,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "grok",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
        inlineCitations: result.inlineCitations,
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createGrokWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => {
      const grok = searchConfig?.grok;
      return grok && typeof grok === "object" && !Array.isArray(grok)
        ? (grok as Record<string, unknown>).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const scoped = searchConfigTarget.grok;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        searchConfigTarget.grok = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "xai")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "xai", "apiKey", value);
    },
    createTool: (ctx) =>
      createGrokToolDefinition(
        (() => {
          const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
          const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "xai");
          if (!pluginConfig) {
            return searchConfig;
          }
          return {
            ...(searchConfig ?? {}),
            grok: {
              ...resolveGrokConfig(searchConfig),
              ...pluginConfig,
            },
          } as SearchConfigRecord;
        })(),
      ),
  };
}

export const __testing = {
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
} as const;
