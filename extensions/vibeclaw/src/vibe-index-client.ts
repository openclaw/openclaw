/**
 * Vibe Index API Client
 * Connects to vibeindex.ai to search, discover, and get install info for skills/plugins/MCP servers.
 */

const VIBE_INDEX_BASE_URL = "https://vibeindex.ai/api/v1";

export interface VibeResource {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  description_ko: string | null;
  resource_type: "skill" | "plugin" | "mcp" | "marketplace";
  github_owner: string | null;
  github_repo: string | null;
  github_url: string | null;
  stars: number;
  tags: string[];
  is_official: boolean;
  is_verified: boolean;
  security_score: number | null;
  security_flags: string[] | null;
  cisco_scan_result: {
    is_safe: boolean;
    max_severity: string;
    findings_count: number;
  } | null;
  relevance_score?: number;
  badges?: { official: boolean; verified: boolean; trending: boolean };
  star_info?: { count: number; inherited: boolean };
  computed_install_command?: string;
}

export interface VibeSearchResult {
  success: boolean;
  data: VibeResource[];
  pagination?: { limit: number; offset: number; total: number };
}

export interface VibeInstallResult {
  success: boolean;
  data: {
    name: string;
    type: string;
    github_url: string;
    install_command: string;
    alternatives: Array<{ name: string; type: string }>;
  };
}

export interface VibeTrendingResult {
  success: boolean;
  data: Array<VibeResource & { star_growth?: number; growth_percent?: number }>;
}

export class VibeIndexClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? VIBE_INDEX_BASE_URL;
  }

  private async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }

    const response = await globalThis.fetch(url.toString(), {
      headers: {
        "X-API-Key": this.apiKey,
        "User-Agent": "VibeClaw/0.3.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Vibe Index API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Search for resources by keyword
   */
  async search(query: string, opts?: {
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<VibeSearchResult> {
    return this.fetch<VibeSearchResult>("/search", {
      q: query,
      type: opts?.type ?? "",
      limit: String(opts?.limit ?? 5),
      offset: String(opts?.offset ?? 0),
    });
  }

  /**
   * Get install command for a specific resource
   */
  async getInstallInfo(name: string, type?: string): Promise<VibeInstallResult> {
    return this.fetch<VibeInstallResult>("/install", {
      name,
      type: type ?? "",
    });
  }

  /**
   * Get trending resources
   */
  async trending(opts?: {
    period?: "day" | "week" | "month";
    type?: string;
    limit?: number;
  }): Promise<VibeTrendingResult> {
    return this.fetch<VibeTrendingResult>("/trending", {
      period: opts?.period ?? "week",
      type: opts?.type ?? "",
      limit: String(opts?.limit ?? 5),
    });
  }
}
