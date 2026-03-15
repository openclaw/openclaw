import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";

type TavilyPluginConfig = {
  apiKey?: string;
  searchDepth?: "basic" | "advanced";
};

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
};

type TavilySearchResponse = {
  answer?: string;
  results?: TavilySearchResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvePluginConfig(value: unknown): TavilyPluginConfig {
  if (!isRecord(value)) {
    return {};
  }
  return value as TavilyPluginConfig;
}

function resolveRootPluginConfig(
  config: OpenClawPluginApi["config"],
  pluginId: string,
): TavilyPluginConfig {
  return resolvePluginConfig(config?.plugins?.entries?.[pluginId]?.config);
}

function resolveApiKey(config: TavilyPluginConfig): string | undefined {
  return normalizeString(config.apiKey) ?? normalizeString(process.env.TAVILY_API_KEY);
}

function resolveSearchDepth(config: TavilyPluginConfig): "basic" | "advanced" {
  return config.searchDepth === "advanced" ? "advanced" : "basic";
}

function resolveFreshnessDays(freshness?: string): number | undefined {
  const normalized = normalizeString(freshness)?.toLowerCase();
  if (normalized === "day") {
    return 1;
  }
  if (normalized === "week") {
    return 7;
  }
  if (normalized === "month") {
    return 30;
  }
  if (normalized === "year") {
    return 365;
  }
  return undefined;
}

const plugin = {
  id: "tavily-search",
  name: "Tavily Search",
  description: "External Tavily web_search provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerSearchProvider({
      id: "tavily",
      name: "Tavily Search",
      description:
        "Search the web using Tavily via an external plugin provider. Returns structured results and an AI-synthesized answer when available.",
      docsUrl: "https://docs.tavily.com/",
      configFieldOrder: ["apiKey", "searchDepth"],
      isAvailable: (config) =>
        Boolean(resolveApiKey(resolveRootPluginConfig(config ?? {}, api.id))),
      search: async (params, ctx) => {
        const pluginConfig = resolvePluginConfig(ctx.pluginConfig);
        const apiKey = resolveApiKey(pluginConfig);
        if (!apiKey) {
          return {
            error: "missing_tavily_api_key",
            message:
              "Tavily search provider needs an API key. Set plugins.entries.tavily-search.config.apiKey or TAVILY_API_KEY in the Gateway environment.",
          };
        }

        const freshnessDays = resolveFreshnessDays(params.freshness);
        const body: Record<string, unknown> = {
          api_key: apiKey,
          query: params.query,
          max_results: params.count,
          search_depth: resolveSearchDepth(pluginConfig),
          include_answer: true,
          include_raw_content: false,
          topic: freshnessDays ? "news" : "general",
        };
        if (freshnessDays !== undefined) {
          body.days = freshnessDays;
        }
        if (params.country) {
          body.country = params.country;
        }

        const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(ctx.timeoutSeconds, 1) * 1000),
        });

        if (!response.ok) {
          const detail = await response.text();
          return {
            error: "search_failed",
            message: `Tavily search failed (${response.status}): ${detail || response.statusText}`,
          };
        }

        const data = (await response.json()) as TavilySearchResponse;
        const results = Array.isArray(data.results) ? data.results : [];

        return {
          content: normalizeString(data.answer),
          citations: results
            .map((entry) => normalizeString(entry.url))
            .filter((entry): entry is string => Boolean(entry)),
          results: results
            .map((entry) => {
              const url = normalizeString(entry.url);
              if (!url) {
                return undefined;
              }
              return {
                url,
                title: normalizeString(entry.title),
                description: normalizeString(entry.content),
                published: normalizeString(entry.published_date),
              };
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
        };
      },
    });
  },
};

export default plugin;
