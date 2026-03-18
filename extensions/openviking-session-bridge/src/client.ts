/** Minimal HTTP client for the OpenViking session API. */
export class OVSessionBridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly agentId: string,
    private readonly timeoutMs: number,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers ?? {});
      if (this.apiKey) headers.set("X-API-Key", this.apiKey);
      if (this.agentId) headers.set("X-OpenViking-Agent", this.agentId);
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const payload = (await res.json().catch(() => ({}))) as {
        status?: string;
        result?: T;
        error?: { code?: string; message?: string };
      };

      if (!res.ok || payload.status === "error") {
        const code = payload.error?.code ? ` [${payload.error.code}]` : "";
        const msg = payload.error?.message ?? `HTTP ${res.status}`;
        throw new Error(`OpenViking request failed${code}: ${msg}`);
      }

      return (payload.result ?? payload) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<void> {
    await this.request<{ status: string }>("/health");
  }

  /** Create a new session; returns the server-assigned session ID. */
  async createSession(): Promise<string> {
    const result = await this.request<{ session_id: string }>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return result.session_id;
  }

  /** Append a single message to an existing OV session. */
  async addSessionMessage(sessionId: string, role: string, content: string): Promise<void> {
    await this.request<{ session_id: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role, content }),
      },
    );
  }

  /**
   * Commit a session — archives it and triggers memory extraction.
   * Uses wait=true by default (blocks until complete).
   */
  async commitSession(sessionId: string): Promise<void> {
    await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit?wait=true`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  }

  /** Delete a session (cleanup fallback). */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }
}
