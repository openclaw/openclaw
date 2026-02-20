import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { parseOrThrow, searchPostSchema } from "@/lib/schemas";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  favicon: string;
  domain: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  source: "brave" | "duckduckgo";
  error?: string;
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Get favicon URL using Google's favicon service
 */
function getFaviconUrl(url: string): string {
  const domain = extractDomain(url);
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

/**
 * Search using Brave Search API
 */
async function searchBrave(query: string, count: number = 5): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY not configured");
  }

  const params = new URLSearchParams({
    q: query,
    count: count.toString(),
    text_decorations: "false",
    search_lang: "en",
  });

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave Search API error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const webResults = data.web?.results || [];

  return webResults.map((result: {
    title: string;
    url: string;
    description?: string;
  }) => ({
    title: result.title,
    url: result.url,
    snippet: result.description || "",
    favicon: getFaviconUrl(result.url),
    domain: extractDomain(result.url),
  }));
}

/**
 * Search using DuckDuckGo HTML scraping (fallback)
 * Note: This is a simple fallback - DuckDuckGo doesn't have a public API
 */
async function searchDuckDuckGo(query: string, count: number = 5): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
  });

  // DuckDuckGo Instant Answer API (limited results)
  const response = await fetch(
    `https://api.duckduckgo.com/?${params}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OpenClawBot/1.0)",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo API error: ${response.status}`);
  }

  const data = await response.json();
  const results: SearchResult[] = [];

  // Extract from RelatedTopics
  const topics = data.RelatedTopics || [];
  for (const topic of topics.slice(0, count)) {
    if (topic.FirstURL && topic.Text) {
      results.push({
        title: topic.Text.split(" - ")[0] || topic.Text,
        url: topic.FirstURL,
        snippet: topic.Text,
        favicon: getFaviconUrl(topic.FirstURL),
        domain: extractDomain(topic.FirstURL),
      });
    }
  }

  // If we have an Abstract, add it
  if (data.AbstractURL && data.Abstract && results.length < count) {
    results.unshift({
      title: data.Heading || "Summary",
      url: data.AbstractURL,
      snippet: data.Abstract,
      favicon: getFaviconUrl(data.AbstractURL),
      domain: extractDomain(data.AbstractURL),
    });
  }

  return results.slice(0, count);
}

/**
 * POST /api/search — perform web search
 * 
 * Body: { query: string, count?: number }
 * Returns: SearchResponse
 */
export const POST = withApiGuard(async (req: NextRequest) => {
  try {
    const { query, count = 5 } = parseOrThrow(searchPostSchema, await req.json());
    const trimmedQuery = query.trim();
    let results: SearchResult[] = [];
    let source: "brave" | "duckduckgo" = "brave";

    // Try Brave Search first
    if (process.env.BRAVE_SEARCH_API_KEY) {
      try {
        results = await searchBrave(trimmedQuery, count);
        source = "brave";
        console.log(`[search] Brave returned ${results.length} results for: ${trimmedQuery}`);
      } catch (braveErr) {
        console.warn("[search] Brave Search failed, falling back to DuckDuckGo:", braveErr);
      }
    }

    // Fallback to DuckDuckGo if Brave failed or no API key
    if (results.length === 0) {
      try {
        results = await searchDuckDuckGo(trimmedQuery, count);
        source = "duckduckgo";
        console.log(`[search] DuckDuckGo returned ${results.length} results for: ${trimmedQuery}`);
      } catch (ddgErr) {
        console.error("[search] DuckDuckGo also failed:", ddgErr);
        return NextResponse.json(
          { 
            error: "Search failed", 
            detail: "Both search providers failed",
            results: [],
            query: trimmedQuery,
            source: "brave" as const
          },
          { status: 502 }
        );
      }
    }

    const response: SearchResponse = {
      results,
      query: trimmedQuery,
      source,
    };

    return NextResponse.json(response);

  } catch (error) {
    return handleApiError(error, "Failed to perform search");
  }
}, ApiGuardPresets.expensive);

/**
 * GET /api/search — simple health check / info
 */
export const GET = withApiGuard(async () => {
  const hasBraveKey = !!process.env.BRAVE_SEARCH_API_KEY;
  return NextResponse.json({
    status: "ok",
    providers: {
      brave: hasBraveKey ? "available" : "not configured",
      duckduckgo: "available (fallback)",
    },
  });
}, ApiGuardPresets.read);
