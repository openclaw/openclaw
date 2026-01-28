import type { SearchResult, Observation } from "./types.js";

export class ClaudeMemClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeout: number,
  ) {}

  /**
   * Check if the claude-mem worker is healthy.
   * Returns true if the worker responds to health check, false otherwise.
   */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeout),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Record an observation to the claude-mem worker.
   * Fire-and-forget pattern: errors are logged but do not block.
   */
  async observe(
    claudeSessionId: string,
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
    cwd?: string,
  ): Promise<void> {
    try {
      const body = {
        claudeSessionId,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        ...(cwd && { cwd }),
      };

      await fetch(`${this.baseUrl}/api/sessions/observations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      // Fire-and-forget: we don't check response status or throw on errors
    } catch {
      // Silently ignore errors - worker may be offline
      // This is intentional: observations should never block the main flow
    }
  }

  /**
   * Search observations by query.
   * Returns an array of search results with id, title, snippet, and score.
   */
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    try {
      const searchParams = new URLSearchParams({
        query,
        type: "observations",
        format: "index",
        limit: String(limit),
      });

      const response = await fetch(
        `${this.baseUrl}/api/search?${searchParams.toString()}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(this.timeout),
        },
      );

      if (!response.ok) {
        return [];
      }

      const data = await response.json();

      // The API returns results in an array format
      if (Array.isArray(data)) {
        return data as SearchResult[];
      }

      // Handle wrapped response format { results: [...] }
      if (data && Array.isArray(data.results)) {
        return data.results as SearchResult[];
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch full observation details by IDs.
   * Returns observations with narrative, files_modified, tool_name, tool_input, tool_response, and created_at_epoch.
   */
  async getObservations(ids: number[]): Promise<Observation[]> {
    if (ids.length === 0) {
      return [];
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/observations/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();

      // Handle direct array response
      if (Array.isArray(data)) {
        return data as Observation[];
      }

      // Handle wrapped response format { observations: [...] }
      if (data && Array.isArray(data.observations)) {
        return data.observations as Observation[];
      }

      return [];
    } catch {
      return [];
    }
  }
}
