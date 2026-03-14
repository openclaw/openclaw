/**
 * LangGraph Platform API Client
 *
 * Native client for LangGraph's REST API — replaces A2A JSON-RPC protocol.
 * Endpoints: /ok, /threads, /threads/{id}/runs/stream, /threads/{id}/state
 *
 * Network-retryable methods use exponential backoff for transient failures
 * (network errors, 5xx, 429). Non-retryable: 4xx client errors.
 */

export type LangGraphStreamEvent = {
  event: string; // "updates" | "end" | "error" | "metadata"
  data: Record<string, unknown>;
};

/** Retry config per operation type. */
type RetryPolicy = { maxRetries: number; baseDelayMs: number };

const RETRY_POLICIES: Record<string, RetryPolicy> = {
  createThread: { maxRetries: 2, baseDelayMs: 1_000 },
  createStreamingRun: { maxRetries: 1, baseDelayMs: 2_000 },
  getThreadState: { maxRetries: 3, baseDelayMs: 2_000 },
};

function isRetryable(err: unknown): boolean {
  // Network errors (fetch failures, DNS, connection refused)
  if (err instanceof TypeError) return true;
  // Timeout errors
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  // Server errors wrapped in our Error messages
  if (err instanceof Error) {
    const match = /failed: (\d+)/.exec(err.message);
    if (match) {
      const status = Number(match[1]);
      return status >= 500 || status === 429;
    }
  }
  return false;
}

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  policy?: RetryPolicy,
): Promise<T> {
  const { maxRetries, baseDelayMs } = policy ?? { maxRetries: 0, baseDelayMs: 0 };
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isRetryable(err)) {
        const delay = baseDelayMs * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export class LangGraphClient {
  constructor(
    private baseUrl: string,
    private assistantId: string,
  ) {}

  /** Health check — GET /ok (no retry — fire-and-forget) */
  async healthCheck(): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}/ok`, {
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  }

  /** Create a new thread — POST /threads (retries: 2, backoff 1s→3s) */
  async createThread(metadata?: Record<string, unknown>): Promise<{ thread_id: string }> {
    return withRetry(
      "createThread",
      async () => {
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
      },
      RETRY_POLICIES.createThread,
    );
  }

  /**
   * Create a streaming run — POST /threads/{threadId}/runs/stream
   * Returns the raw Response for the caller to consume as SSE.
   * Retries: 1, backoff 2s (only retries network/5xx errors).
   */
  async createStreamingRun(
    threadId: string,
    messages: Array<{ role: string; content: string }>,
    context?: Record<string, unknown>,
  ): Promise<Response> {
    return withRetry(
      "createStreamingRun",
      async () => {
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
      },
      RETRY_POLICIES.createStreamingRun,
    );
  }

  /** Get thread state — GET /threads/{threadId}/state (retries: 3, backoff 2s→4s→8s) */
  async getThreadState(threadId: string): Promise<unknown> {
    return withRetry(
      "getThreadState",
      async () => {
        const resp = await fetch(`${this.baseUrl}/threads/${threadId}/state`, {
          signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) {
          throw new Error(`LangGraph getThreadState failed: ${resp.status} ${resp.statusText}`);
        }

        return resp.json();
      },
      RETRY_POLICIES.getThreadState,
    );
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
