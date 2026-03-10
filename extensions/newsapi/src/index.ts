import { Type } from "@sinclair/typebox";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk/core";

// NewsAPI supported country codes (ISO 3166-1 alpha-2)
const COUNTRY_CODES = [
  "ae",
  "ar",
  "at",
  "au",
  "be",
  "bg",
  "br",
  "ca",
  "ch",
  "cn",
  "co",
  "cu",
  "cz",
  "de",
  "eg",
  "fr",
  "gb",
  "gr",
  "hk",
  "hu",
  "id",
  "ie",
  "il",
  "in",
  "it",
  "jp",
  "kr",
  "lt",
  "lv",
  "ma",
  "mx",
  "my",
  "ng",
  "nl",
  "no",
  "nz",
  "ph",
  "pl",
  "pt",
  "ro",
  "rs",
  "ru",
  "sa",
  "se",
  "sg",
  "si",
  "sk",
  "th",
  "tr",
  "tw",
  "ua",
  "us",
  "ve",
  "za",
] as const;

// NewsAPI supported categories
const CATEGORIES = [
  "business",
  "entertainment",
  "general",
  "health",
  "science",
  "sports",
  "technology",
] as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_ARTICLES_RETURNED = 5;

type NewsApiConfig = {
  apiKey?: string;
};

type NewsApiArticle = {
  source?: { name?: string };
  title?: string;
  description?: string;
  url?: string;
  publishedAt?: string;
};

type NewsApiResponse = {
  status?: string;
  totalResults?: number;
  articles?: NewsApiArticle[];
  code?: string;
  message?: string;
};

export default function (api: OpenClawPluginApi) {
  const pluginCfg = (api.pluginConfig ?? {}) as NewsApiConfig;
  const apiKey = pluginCfg.apiKey;

  if (apiKey && typeof apiKey === "string" && apiKey.trim()) {
    api.logger.info("newsapi: initialized with valid API key");
  }

  const getTopHeadlinesTool: AnyAgentTool = {
    name: "newsapi_get_top_headlines",
    label: "NewsAPI: Get Top Headlines",
    description:
      "Get top news headlines from NewsAPI.org based on country, category, or search query. Requires the NewsAPI extension to be configured with an API key.",
    parameters: Type.Object({
      country: Type.Optional(
        Type.Unsafe<(typeof COUNTRY_CODES)[number]>({
          type: "string",
          enum: COUNTRY_CODES,
          description: "The 2-letter ISO 3166-1 code of the country (e.g., us, gb, cn, jp).",
        }),
      ),
      category: Type.Optional(
        Type.Unsafe<(typeof CATEGORIES)[number]>({
          type: "string",
          enum: CATEGORIES,
          description:
            "The category to get headlines for (business, entertainment, general, health, science, sports, technology).",
        }),
      ),
      q: Type.Optional(Type.String({ description: "Keywords or a phrase to search for." })),
      pageSize: Type.Optional(
        Type.Number({
          description: "The number of results to return (default: 20, max: 100).",
          minimum: 1,
          maximum: MAX_PAGE_SIZE,
        }),
      ),
    }),
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        api.logger.warn?.("newsapi: execute called but API key not available");
        throw new Error("NewsAPI Key is not configured.");
      }

      // Validate and normalize pageSize
      let pageSize = DEFAULT_PAGE_SIZE;
      if (typeof args.pageSize === "number" && Number.isFinite(args.pageSize)) {
        pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(args.pageSize)));
      }

      const params = new URLSearchParams();
      params.append("apiKey", apiKey.trim());

      if (args.country && typeof args.country === "string") {
        params.append("country", args.country);
      }
      if (args.category && typeof args.category === "string") {
        params.append("category", args.category);
      }
      if (args.q && typeof args.q === "string") {
        params.append("q", args.q);
      }
      params.append("pageSize", String(pageSize));

      // Use 'us' as default country if no country, category, or query is provided
      if (!args.country && !args.category && !args.q) {
        params.append("country", "us");
      }

      const url = `https://newsapi.org/v2/top-headlines?${params.toString()}`;
      api.logger.debug?.(`newsapi: fetching ${url.replace(apiKey.trim(), "[REDACTED]")}`);

      try {
        // Use OpenClaw's guarded fetch for proper network handling
        // mode: trusted_env_proxy to support proxy environments for external APIs
        const { response, release } = await fetchWithSsrFGuard({
          url,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal,
          mode: "trusted_env_proxy",
        });

        try {
          const data = (await response.json()) as NewsApiResponse;

          if (!response.ok || data.status === "error") {
            const errorMsg = data.message || data.code || `HTTP ${response.status}`;
            throw new Error(`NewsAPI error: ${errorMsg}`);
          }

          const resultString = JSON.stringify({
            status: data.status,
            totalResults: data.totalResults,
            articles: data.articles?.slice(0, MAX_ARTICLES_RETURNED).map((a) => ({
              source: a.source?.name,
              title: a.title,
              description: a.description,
              url: a.url,
              publishedAt: a.publishedAt,
            })),
          });

          return {
            content: [{ type: "text", text: resultString }],
            details: {},
          };
        } finally {
          await release();
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          return {
            content: [{ type: "text", text: "NewsAPI request timed out after 15 seconds." }],
            details: { error: "timeout" },
          };
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCause = error instanceof Error && error.cause ? String(error.cause) : undefined;
        api.logger.warn?.(
          `newsapi: fetch error: ${errorMessage}${errorCause ? ` (cause: ${errorCause})` : ""}`,
        );
        return {
          content: [{ type: "text", text: `Failed to fetch from NewsAPI: ${errorMessage}` }],
          details: { error: errorMessage, cause: errorCause },
        };
      }
    },
  };

  api.registerTool(getTopHeadlinesTool);
}
