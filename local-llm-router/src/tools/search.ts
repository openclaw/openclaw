/**
 * Search tool — web search via SearXNG (self-hosted) or fallback to Brave.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  durationMs: number;
}

const DEFAULT_SEARXNG_URL = "http://localhost:8888";
const DEFAULT_MAX_RESULTS = 10;

/**
 * Search via SearXNG (self-hosted, privacy-respecting).
 */
export async function searchSearXNG(
  query: string,
  opts?: {
    baseUrl?: string;
    maxResults?: number;
    categories?: string[];
    language?: string;
  },
): Promise<SearchResponse> {
  const baseUrl = opts?.baseUrl ?? process.env.SEARXNG_URL ?? DEFAULT_SEARXNG_URL;
  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

  const params = new URLSearchParams({
    q: query,
    format: "json",
    pageno: "1",
  });

  if (opts?.categories?.length) {
    params.set("categories", opts.categories.join(","));
  }
  if (opts?.language) {
    params.set("language", opts.language);
  }

  const start = Date.now();

  const response = await fetch(`${baseUrl}/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`SearXNG error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    results: Array<{
      title: string;
      url: string;
      content: string;
      engine: string;
    }>;
  };

  const results: SearchResult[] = data.results
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      source: r.engine,
    }));

  // Deduplicate by domain
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    try {
      const domain = new URL(r.url).hostname;
      if (seen.has(domain)) return false;
      seen.add(domain);
      return true;
    } catch {
      return true;
    }
  });

  return {
    query,
    results: deduped,
    durationMs: Date.now() - start,
  };
}

/**
 * Fallback: Search via Brave Search API.
 */
export async function searchBrave(
  query: string,
  opts?: { maxResults?: number },
): Promise<SearchResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY not set");
  }

  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
  const start = Date.now();

  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
  });

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Brave Search error: ${response.status}`);
  }

  const data = (await response.json()) as {
    web?: { results: Array<{ title: string; url: string; description: string }> };
  };

  const results: SearchResult[] = (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
    source: "brave",
  }));

  return {
    query,
    results,
    durationMs: Date.now() - start,
  };
}

/**
 * Search with automatic fallback: SearXNG → Brave.
 */
export async function search(
  query: string,
  opts?: { maxResults?: number },
): Promise<SearchResponse> {
  try {
    return await searchSearXNG(query, opts);
  } catch {
    // SearXNG not available, try Brave
    try {
      return await searchBrave(query, opts);
    } catch (err) {
      throw new Error(
        `All search engines failed. Ensure SearXNG is running or BRAVE_SEARCH_API_KEY is set. Last error: ${err}`,
      );
    }
  }
}
