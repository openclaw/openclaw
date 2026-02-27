/**
 * SerpApi Search Provider Plugin for OpenClaw
 *
 * Provides Google search with vertical search routing:
 * - google (default): Regular web search
 * - google_news: News articles
 * - google_scholar: Academic papers
 * - google_images: Image search
 * - google_shopping: Product/price search
 * - google_maps: Local places/POI
 * - google_jobs: Job listings
 * - google_finance: Financial data
 * - google_patents: Patent search
 * - youtube: YouTube video search
 * - bing / baidu / yandex / naver: Alternative engines
 *
 * The LLM selects the appropriate vertical via the `engine` parameter
 * in the web_search tool call — zero extra token cost.
 */

import type { OpenClawPluginModule } from "openclaw/plugin-sdk";

/** Supported engine → SerpApi engine mapping */
const ENGINE_MAP: Record<string, string> = {
  // Google verticals
  google: "google",
  news: "google_news",
  google_news: "google_news",
  scholar: "google_scholar",
  google_scholar: "google_scholar",
  images: "google_images",
  google_images: "google_images",
  shopping: "google_shopping",
  google_shopping: "google_shopping",
  maps: "google_maps",
  google_maps: "google_maps",
  jobs: "google_jobs",
  google_jobs: "google_jobs",
  finance: "google_finance",
  google_finance: "google_finance",
  patents: "google_patents",
  google_patents: "google_patents",
  // YouTube
  youtube: "youtube",
  // Alternative engines
  bing: "bing",
  baidu: "baidu",
  yandex: "yandex",
  naver: "naver",
  duckduckgo: "duckduckgo",
};

const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";

interface SerpApiOrganic {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  source?: string;
  displayed_link?: string;
}

interface SerpApiNewsResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  source?: string;
  thumbnail?: string;
}

interface SerpApiScholarResult {
  title?: string;
  link?: string;
  snippet?: string;
  publication_info?: { summary?: string };
  inline_links?: { cited_by?: { total?: number; link?: string } };
}

interface SerpApiImageResult {
  title?: string;
  link?: string;
  original?: string;
  thumbnail?: string;
  source?: string;
}

interface SerpApiShoppingResult {
  title?: string;
  link?: string;
  price?: string;
  extracted_price?: number;
  source?: string;
  rating?: number;
  reviews?: number;
  snippet?: string;
  thumbnail?: string;
}

interface SerpApiLocalResult {
  title?: string;
  place_id?: string;
  address?: string;
  rating?: number;
  reviews?: number;
  type?: string;
  phone?: string;
  website?: string;
  gps_coordinates?: { latitude?: number; longitude?: number };
}

interface SerpApiResponse {
  search_metadata?: { total_time_taken?: number };
  organic_results?: SerpApiOrganic[];
  news_results?: SerpApiNewsResult[];
  scholarly_articles?: SerpApiScholarResult[];
  images_results?: SerpApiImageResult[];
  shopping_results?: SerpApiShoppingResult[];
  local_results?: SerpApiLocalResult[];
  [key: string]: unknown;
}

function resolveEngine(raw?: string): string {
  if (!raw) return "google";
  const normalized = raw.trim().toLowerCase();
  return ENGINE_MAP[normalized] || "google";
}

/**
 * Extract results from different SerpApi response shapes based on engine type.
 */
function extractResults(
  engine: string,
  data: SerpApiResponse,
): Array<{
  title: string;
  url: string;
  description?: string;
  published?: string;
  siteName?: string;
}> {
  // Google News
  if (engine === "google_news" && data.news_results) {
    return data.news_results.map((r) => ({
      title: r.title || "",
      url: r.link || "",
      description: r.snippet || "",
      published: r.date || undefined,
      siteName: r.source || undefined,
    }));
  }

  // Google Scholar
  if (engine === "google_scholar" && data.scholarly_articles) {
    return data.scholarly_articles.map((r) => ({
      title: r.title || "",
      url: r.link || "",
      description: [
        r.snippet,
        r.publication_info?.summary,
        r.inline_links?.cited_by?.total ? `Cited by ${r.inline_links.cited_by.total}` : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
    }));
  }

  // Google Images
  if (engine === "google_images" && data.images_results) {
    return data.images_results.slice(0, 10).map((r) => ({
      title: r.title || "",
      url: r.original || r.link || "",
      description: r.source || "",
      siteName: r.source || undefined,
    }));
  }

  // Google Shopping
  if (engine === "google_shopping" && data.shopping_results) {
    return data.shopping_results.map((r) => ({
      title: r.title || "",
      url: r.link || "",
      description: [
        r.price,
        r.rating ? `★${r.rating}` : undefined,
        r.reviews ? `(${r.reviews} reviews)` : undefined,
        r.snippet,
      ]
        .filter(Boolean)
        .join(" · "),
      siteName: r.source || undefined,
    }));
  }

  // Google Maps / Local
  if (engine === "google_maps" && data.local_results) {
    return data.local_results.map((r) => ({
      title: r.title || "",
      url: r.website || "",
      description: [
        r.type,
        r.address,
        r.rating ? `★${r.rating}` : undefined,
        r.reviews ? `(${r.reviews} reviews)` : undefined,
        r.phone,
      ]
        .filter(Boolean)
        .join(" · "),
    }));
  }

  // Default: organic results (google, bing, baidu, yandex, etc.)
  if (data.organic_results) {
    return data.organic_results.map((r) => ({
      title: r.title || "",
      url: r.link || "",
      description: r.snippet || "",
      published: r.date || undefined,
      siteName: r.source || undefined,
    }));
  }

  return [];
}

const plugin: OpenClawPluginModule = {
  id: "serpapi-search",
  name: "SerpApi Search Provider",
  description:
    "Google search with vertical routing: news, scholar, images, shopping, maps, jobs, finance, patents, YouTube",
  version: "1.0.0",

  register(api) {
    api.registerSearchProvider({
      id: "serpapi",
      label: "SerpApi (Google + Verticals)",
      description:
        "Search the web using SerpApi with vertical search support. " +
        "Supports Google Web, News, Scholar, Images, Shopping, Maps, Jobs, Finance, Patents, YouTube, " +
        "and alternative engines (Bing, Baidu, Yandex, Naver). " +
        "Use the 'engine' parameter to select a vertical: " +
        "google (default), news, scholar, images, shopping, maps, jobs, finance, patents, youtube, bing, baidu, yandex.",

      async search(params, ctx) {
        const pluginConfig = ctx.pluginConfig as
          | { apiKey?: string; defaultEngine?: string }
          | undefined;
        const apiKey = pluginConfig?.apiKey || process.env.SERPAPI_API_KEY;

        if (!apiKey) {
          return {
            error: "missing_serpapi_api_key",
            message:
              "SerpApi API key required. Set SERPAPI_API_KEY env var or configure plugins.entries.serpapi-search.config.apiKey",
            provider: "serpapi",
          };
        }

        // Extract engine from tool params (LLM selects vertical) or config default
        const engine = resolveEngine(params.engine || pluginConfig?.defaultEngine);

        // Build SerpApi request
        const url = new URL(SERPAPI_ENDPOINT);
        url.searchParams.set("api_key", apiKey);
        url.searchParams.set("engine", engine);
        url.searchParams.set("q", params.query);
        url.searchParams.set("num", String(Math.min(params.count, 20)));
        url.searchParams.set("output", "json");

        // Location / language
        if (params.country) {
          url.searchParams.set("gl", params.country.toLowerCase());
        }
        if (params.search_lang) {
          url.searchParams.set("hl", params.search_lang.toLowerCase());
        }

        // Freshness → tbs parameter (Google only)
        if (params.freshness && engine.startsWith("google")) {
          const freshnessMap: Record<string, string> = {
            pd: "qdr:d",
            pw: "qdr:w",
            pm: "qdr:m",
            py: "qdr:y",
          };
          const tbs = freshnessMap[params.freshness] || undefined;
          if (tbs) {
            url.searchParams.set("tbs", tbs);
          }
        }

        const start = Date.now();
        const response = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(ctx.timeoutSeconds * 1000),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`SerpApi error (${response.status}): ${text || response.statusText}`);
        }

        const data = (await response.json()) as SerpApiResponse;
        const results = extractResults(engine, data);

        return {
          query: params.query,
          provider: `serpapi/${engine}`,
          count: results.length,
          tookMs: Date.now() - start,
          results,
        };
      },
    });
  },

  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          description: "SerpApi API key",
        },
        defaultEngine: {
          type: "string",
          description:
            "Default search engine (google, news, scholar, images, shopping, maps, etc.)",
          default: "google",
        },
      },
    },
    uiHints: {
      apiKey: {
        label: "SerpApi API Key",
        help: "Get your API key from https://serpapi.com/manage-api-key",
        sensitive: true,
      },
      defaultEngine: {
        label: "Default Engine",
        help: "Default vertical to use when no engine is specified",
      },
    },
  },
};

export default plugin;
