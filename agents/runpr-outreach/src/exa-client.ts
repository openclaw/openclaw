// Thin wrapper around the Exa REST API. The official `exa-js` SDK works, but a fetch wrapper keeps
// the dependency list small and the error handling explicit.

interface ExaSearchOptions {
  numResults?: number;
  type?: "neural" | "keyword" | "auto";
  useAutoprompt?: boolean;
  category?: string;
  startPublishedDate?: string;
  endPublishedDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  text?: boolean | { maxCharacters?: number };
}

export interface ExaResult {
  id: string;
  url: string;
  title: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  score?: number;
}

export interface ExaSearchResponse {
  results: ExaResult[];
  autopromptString?: string;
}

const EXA_BASE = "https://api.exa.ai";

export class ExaClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("ExaClient requires an api key");
  }

  async search(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResponse> {
    const body: Record<string, unknown> = {
      query,
      numResults: options.numResults ?? 10,
      type: options.type ?? "auto",
      useAutoprompt: options.useAutoprompt ?? true,
    };
    if (options.category) body.category = options.category;
    if (options.startPublishedDate) body.startPublishedDate = options.startPublishedDate;
    if (options.endPublishedDate) body.endPublishedDate = options.endPublishedDate;
    if (options.includeDomains) body.includeDomains = options.includeDomains;
    if (options.excludeDomains) body.excludeDomains = options.excludeDomains;
    if (options.text) {
      body.contents = {
        text: typeof options.text === "object" ? options.text : { maxCharacters: 1500 },
      };
    }

    const res = await fetch(`${EXA_BASE}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Exa search failed (${res.status}): ${text.slice(0, 500)}`);
    }
    return (await res.json()) as ExaSearchResponse;
  }

  async getContents(urls: string[]): Promise<{ results: ExaResult[] }> {
    if (urls.length === 0) return { results: [] };
    const res = await fetch(`${EXA_BASE}/contents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        urls,
        text: { maxCharacters: 4000 },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Exa contents failed (${res.status}): ${text.slice(0, 500)}`);
    }
    return (await res.json()) as { results: ExaResult[] };
  }
}
