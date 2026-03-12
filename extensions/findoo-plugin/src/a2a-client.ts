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
};

export type A2ARequest = {
  jsonrpc: "2.0";
  id: string;
  method: "message/send" | "tasks/get";
  params: {
    message?: A2AMessage;
    thread?: { threadId: string };
    taskId?: string;
  };
};

export type A2AResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
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
   * Get task status/result by task ID.
   */
  async getTask(taskId: string): Promise<A2AResponse> {
    const body: A2ARequest = {
      jsonrpc: "2.0",
      id: `req-${Date.now()}`,
      method: "tasks/get",
      params: { taskId },
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
