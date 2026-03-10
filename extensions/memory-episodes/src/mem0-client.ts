/**
 * Mem0 REST API Client
 *
 * Thin HTTP client for coordinating with the Mem0 long-term memory service.
 * All methods are fail-safe: they return null/empty on network errors.
 */

export type Mem0Memory = {
  id: string;
  memory: string;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
};

type Mem0SearchResponse = {
  results?: Mem0Memory[];
};

type Mem0ListResponse = {
  results?: Mem0Memory[];
};

export class Mem0Client {
  constructor(private readonly baseUrl: string) {}

  async search(query: string, userId: string, limit = 5): Promise<Mem0Memory[]> {
    try {
      const response = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, user_id: userId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as Mem0SearchResponse;
      const results = data.results ?? [];
      return results.slice(0, limit);
    } catch {
      return [];
    }
  }

  async list(userId: string): Promise<Mem0Memory[]> {
    try {
      const response = await fetch(
        `${this.baseUrl}/memories?user_id=${encodeURIComponent(userId)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as Mem0ListResponse;
      return data.results ?? [];
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async health(): Promise<{ status: string } | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as { status: string };
    } catch {
      return null;
    }
  }
}
