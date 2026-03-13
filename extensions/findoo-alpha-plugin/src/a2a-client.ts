/**
 * A2A (Agent-to-Agent) Protocol Client
 *
 * Implements Google A2A standard (JSON-RPC 2.0) for communicating
 * with LangGraph strategy-agent.
 *
 * Protocol: POST /a2a/{assistant_id}
 * Methods:  message/send, tasks/get
 */

export type A2ATextPart = { kind: "text"; text: string };
export type A2ADataPart = { kind: "data"; data: Record<string, unknown> };
export type A2APart = A2ATextPart | A2ADataPart;

export type A2AMessage = {
  role: "user" | "assistant";
  parts: A2APart[];
  messageId: string;
  metadata?: Record<string, unknown>;
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

/** A single parsed SSE event from message/stream (used by collectStreamResult) */
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
   * Send a message to the strategy agent via A2A protocol (message/send).
   * Supports optional metadata for webhook callback injection.
   */
  async sendMessage(
    text: string,
    options?: {
      data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      threadId?: string;
      timeoutMs?: number;
    },
  ): Promise<A2AResponse> {
    const parts: A2APart[] = [{ kind: "text", text }];
    if (options?.data) {
      parts.push({ kind: "data", data: options.data });
    }

    const message: A2AMessage = {
      role: "user",
      parts,
      messageId: `msg-${Date.now()}`,
    };
    if (options?.metadata) {
      message.metadata = options.metadata;
    }

    const body: A2ARequest = {
      jsonrpc: "2.0",
      id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: "message/send",
      params: {
        message,
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
   * Send message via SSE stream, consume all events, return final result
   * as an A2AResponse (synchronous blocking fallback).
   */
  async collectStreamResult(
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

    // Parse SSE and collect until final event
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastEvent: A2AStreamEvent | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentData = "";

        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line.trim() === "") {
            if (currentData) {
              const event = A2AClient.parseStreamData(currentData);
              currentData = "";

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

              lastEvent = event;
              if (event.final) {
                const result = event.status?.message ?? event.raw;
                return { jsonrpc: "2.0", id: "", result: result as Record<string, unknown> };
              }
            }
            continue;
          }
          if (line.startsWith("data: ")) {
            currentData += line.slice(6);
          }
        }
      }

      // Flush remaining
      if (buffer.trim().startsWith("data: ")) {
        const event = A2AClient.parseStreamData(buffer.trim().slice(6));
        lastEvent = event;
      }
    } finally {
      reader.releaseLock();
    }

    if (!lastEvent) {
      return {
        jsonrpc: "2.0",
        id: "",
        error: { code: -1, message: "No events received from stream" },
      };
    }

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
   * Get task status/result by task ID (for debugging).
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
