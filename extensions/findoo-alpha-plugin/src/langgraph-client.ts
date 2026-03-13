/**
 * LangGraph Platform API Client
 *
 * Native client for LangGraph's REST API — replaces A2A JSON-RPC protocol.
 * Endpoints: /ok, /threads, /threads/{id}/runs/stream, /threads/{id}/state
 */

export type LangGraphStreamEvent = {
  event: string; // "updates" | "end" | "error" | "metadata"
  data: Record<string, unknown>;
};

export class LangGraphClient {
  constructor(
    private baseUrl: string,
    private assistantId: string,
  ) {}

  /** Health check — GET /ok */
  async healthCheck(): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}/ok`, {
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  }

  /** Create a new thread — POST /threads */
  async createThread(metadata?: Record<string, unknown>): Promise<{ thread_id: string }> {
    const body: Record<string, unknown> = {};
    if (metadata) body.metadata = metadata;

    const resp = await fetch(`${this.baseUrl}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      throw new Error(`LangGraph createThread failed: ${resp.status} ${resp.statusText}`);
    }

    return (await resp.json()) as { thread_id: string };
  }

  /**
   * Create a streaming run — POST /threads/{threadId}/runs/stream
   * Returns the raw Response for the caller to consume as SSE.
   */
  async createStreamingRun(
    threadId: string,
    messages: Array<{ role: string; content: string }>,
    context?: Record<string, unknown>,
  ): Promise<Response> {
    const input: Record<string, unknown> = { messages };
    if (context) input.context = context;

    const resp = await fetch(`${this.baseUrl}/threads/${threadId}/runs/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        assistant_id: this.assistantId,
        input,
        stream_mode: "updates",
      }),
    });

    if (!resp.ok) {
      throw new Error(`LangGraph streaming run failed: ${resp.status} ${resp.statusText}`);
    }

    if (!resp.body) {
      throw new Error("LangGraph streaming response has no body");
    }

    return resp;
  }

  /** Get thread state — GET /threads/{threadId}/state */
  async getThreadState(threadId: string): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}/threads/${threadId}/state`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      throw new Error(`LangGraph getThreadState failed: ${resp.status} ${resp.statusText}`);
    }

    return resp.json();
  }

  /**
   * Parse SSE events from a ReadableStream (LangGraph streaming format).
   * Reuses line-buffer pattern from the former A2A client.
   */
  static async *parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<LangGraphStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          // SSE comment — skip
          if (line.startsWith(":")) continue;

          // Empty line — flush accumulated event
          if (line.trim() === "") {
            if (currentData) {
              try {
                const data = JSON.parse(currentData) as Record<string, unknown>;
                yield { event: currentEvent || "message", data };
              } catch {
                // malformed JSON — skip
              }
              currentEvent = "";
              currentData = "";
            }
            continue;
          }

          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData += line.slice(6);
          }
        }
      }

      // Flush remaining buffer
      if (currentData) {
        try {
          const data = JSON.parse(currentData) as Record<string, unknown>;
          yield { event: currentEvent || "message", data };
        } catch {
          // ignore
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
