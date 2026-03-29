const BASE = "https://api.supermemory.ai";

export type ProfileResult = {
  profile: {
    static: string[];
    dynamic: string[];
  };
  searchResults?: {
    results: Array<{ memory?: string; chunk?: string }>;
  };
};

export type SearchResult = {
  results: Array<{ memory?: string; chunk?: string; score?: number }>;
};

async function apiRequest(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-supermemory-api-key": apiKey,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supermemory API error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return {};
}

export async function fetchProfile(
  apiKey: string,
  containerTag: string,
  q: string,
): Promise<ProfileResult> {
  return apiRequest("POST", "/v4/profile", apiKey, { containerTag, q }) as Promise<ProfileResult>;
}

export async function addDocument(
  apiKey: string,
  containerTag: string,
  content: string,
): Promise<void> {
  await apiRequest("POST", "/v3/documents", apiKey, { content, containerTag });
}

export async function searchMemory(
  apiKey: string,
  containerTag: string,
  q: string,
  limit = 5,
): Promise<SearchResult> {
  return apiRequest("POST", "/v4/search", apiKey, {
    q,
    containerTag,
    searchMode: "hybrid",
    limit,
  }) as Promise<SearchResult>;
}

export async function configureSettings(apiKey: string, filterPrompt: string): Promise<void> {
  await apiRequest("PATCH", "/v3/settings", apiKey, {
    shouldLLMFilter: true,
    filterPrompt,
  });
}
