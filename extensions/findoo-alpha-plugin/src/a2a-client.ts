/**
 * A2A (Agent-to-Agent) Protocol Client
 *
 * Implements Google A2A standard (JSON-RPC 2.0) for communicating
 * with LangGraph strategy-agent.
 *
 * Protocol: POST /a2a/{assistant_id}
 * Methods:  message/send, message/stream, tasks/get
 */

export type A2ATextPart = { kind: "text"; text: string };
export type A2ADataPart = { kind: "data"; data: Record<string, unknown> };
export type A2APart = A2ATextPart | A2ADataPart;

export type A2AMessage = {
  role: "user" | "assistant";
  parts: A2APart[];
  messageId: string;
};

export type A2ARequest = {
  jsonrpc: "2.0";
  id: string;
  method: "message/send" | "message/stream" | "tasks/get";
  params: {
    message?: A2AMessage;
    thread?: { threadId: string };
    id?: string;
    contextId?: string;
  };
};

export type A2AResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** A single parsed SSE event from message/stream */
export type A2AStreamEvent = {
  kind: "task" | "status-update" | "artifact-update" | "error" | "unknown";
  status?: { state: string; message?: Record<string, unknown> };
  final: boolean;
  raw: Record<string, unknown>;
};

export class A2AClient {
  constructor(
    private baseUrl: string,
    private assistantId: string,
  ) {}

  /**
   * Send a message to the strategy agent via A2A protocol.
   */
  async sendMessage(
    text: string,
    options?: {
      data?: Record<string, unknown>;
      threadId?: string;
      timeoutMs?: number;
    },
  ): Promise<A2AResponse> {
    const parts: A2APart[] = [{ kind: "text", text }];
    if (options?.data) {
      parts.push({ kind: "data", data: options.data });
    }

    const body: A2ARequest = {
      jsonrpc: "2.0",
      id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts,
          messageId: `msg-${Date.now()}`,
        },
        ...(options?.threadId ? { thread: { threadId: options.threadId } } : {}),
      },
    };

    const resp = await fetch(`${this.baseUrl}/a2a/${this.assistantId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });

    if (!resp.ok) {
      throw new Error(`A2A request failed: ${resp.status} ${resp.statusText}`);
    }

    return (await resp.json()) as A2AResponse;
  }

  /**
   * Send a message via A2A SSE stream (message/stream).
   * Yields parsed events; the final event has `final: true`.
   */
  async *sendMessageStream(
    text: string,
    options?: {
      data?: Record<string, unknown>;
      threadId?: string;
      timeoutMs?: number;
    },
  ): AsyncGenerator<A2AStreamEvent> {
    const parts: A2APart[] = [{ kind: "text", text }];
    if (options?.data) {
      parts.push({ kind: "data", data: options.data });
    }

    const body: A2ARequest = {
      jsonrpc: "2.0",
      id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: "message/stream",
      params: {
        message: {
          role: "user",
          parts,
          messageId: `msg-${Date.now()}`,
        },
        ...(options?.threadId ? { thread: { threadId: options.threadId } } : {}),
      },
    };

    const resp = await fetch(`${this.baseUrl}/a2a/${this.assistantId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });

    if (!resp.ok) {
      throw new Error(`A2A stream request failed: ${resp.status} ${resp.statusText}`);
    }

    if (!resp.body) {
      throw new Error("A2A stream response has no body");
    }

    // Parse SSE line by line from the ReadableStream
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in buffer
        buffer = lines.pop() ?? "";

        let currentData = "";

        for (const line of lines) {
          // Heartbeat comment — ignore
          if (line.startsWith(":")) continue;
          // Empty line = end of event block
          if (line.trim() === "") {
            if (currentData) {
              const event = A2AClient.parseStreamData(currentData);
              currentData = "";
              yield event;
              if (event.final) return;
            }
            continue;
          }
          if (line.startsWith("data: ")) {
            currentData += line.slice(6);
          }
          // "event:" lines are informational; we derive kind from the data payload
        }
      }

      // Flush remaining data in buffer
      if (buffer.trim().startsWith("data: ")) {
        const event = A2AClient.parseStreamData(buffer.trim().slice(6));
        yield event;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Consume the stream until final event, return the completed result
   * as an A2AResponse (same shape as sendMessage for drop-in replacement).
   */
  async collectStreamResult(
    text: string,
    options?: {
      data?: Record<string, unknown>;
      threadId?: string;
      timeoutMs?: number;
    },
  ): Promise<A2AResponse> {
    let lastEvent: A2AStreamEvent | undefined;

    for await (const event of this.sendMessageStream(text, options)) {
      lastEvent = event;
      if (event.kind === "error") {
        const errMsg =
          (event.raw as Record<string, unknown>)?.error ??
          event.status?.message ??
          "Unknown stream error";
        return {
          jsonrpc: "2.0",
          id: "",
          error: {
            code: -1,
            message: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
          },
        };
      }
    }

    if (!lastEvent) {
      return {
        jsonrpc: "2.0",
        id: "",
        error: { code: -1, message: "No events received from stream" },
      };
    }

    // Extract result from the final event's status.message or raw payload
    const result = lastEvent.status?.message ?? lastEvent.raw;
    return { jsonrpc: "2.0", id: "", result: result as Record<string, unknown> };
  }

  /** Parse a JSON data payload from an SSE event into an A2AStreamEvent */
  private static parseStreamData(data: string): A2AStreamEvent {
    try {
      const parsed = JSON.parse(data) as { result?: Record<string, unknown>; error?: unknown };

      if (parsed.error) {
        return { kind: "error", final: true, raw: parsed as Record<string, unknown> };
      }

      const result = parsed.result ?? {};
      const kind = (result.kind as string) ?? "unknown";
      const status = result.status as
        | { state: string; message?: Record<string, unknown> }
        | undefined;
      const final = (result.final as boolean) ?? false;

      return { kind: kind as A2AStreamEvent["kind"], status, final, raw: result };
    } catch {
      return { kind: "unknown", final: false, raw: { unparsed: data } };
    }
  }

  /**
   * Get task status/result by task ID.
   */
  async getTask(taskId: string, contextId?: string): Promise<A2AResponse> {
    const body: A2ARequest = {
      jsonrpc: "2.0",
      id: `req-${Date.now()}`,
      method: "tasks/get",
      params: { id: taskId, ...(contextId ? { contextId } : {}) },
    };

    const resp = await fetch(`${this.baseUrl}/a2a/${this.assistantId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    return (await resp.json()) as A2AResponse;
  }
}
