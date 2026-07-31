import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "Explain the answer", timestamp: 1 }],
} satisfies Context;

function createAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-terminal" } }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

type ProviderTerminal = {
  type: "response.completed" | "response.done" | "response.incomplete";
  response: {
    id: string;
    status?: "completed" | "incomplete";
    incomplete_details?: { reason: "content_filter" | "max_output_tokens" };
    output: Array<Record<string, unknown>>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      input_tokens_details?: { cached_tokens: number; cache_write_tokens: number };
    };
  };
};

async function runTerminal(terminal: ProviderTerminal, transport: "sse" | "websocket" | "auto") {
  const fetchMock = vi.fn(
    async () =>
      new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  if (transport !== "sse") {
    class TerminalWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), { data: JSON.stringify(terminal) }),
          );
        });
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", TerminalWebSocket);
  }

  const stream = streamOpenAICodexResponses(model, context, {
    apiKey: createAccessToken(),
    transport,
    maxRetries: 0,
  });
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, result: await stream.result(), fetchMock };
}

function incompleteTerminal(params: {
  transport: "sse" | "websocket" | "auto";
  reason: "content_filter" | "max_output_tokens";
  status?: "incomplete";
}): ProviderTerminal {
  return {
    type: "response.incomplete",
    response: {
      id: `resp-${params.transport}-${params.reason}-${params.status ?? "omitted"}`,
      ...(params.status ? { status: params.status } : {}),
      incomplete_details: { reason: params.reason },
      output: [
        {
          type: "message",
          id: "msg_partial",
          role: "assistant",
          content: [{ type: "output_text", text: "PROVIDER_PARTIAL" }],
        },
        ...(params.reason === "max_output_tokens"
          ? [
              {
                type: "function_call",
                id: "fc_truncated",
                call_id: "call_truncated",
                name: "write",
                arguments: '{"path":"unfinished',
              },
            ]
          : []),
      ],
      usage: {
        input_tokens: 21,
        output_tokens: 4,
        total_tokens: 25,
        input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
      },
    },
  };
}

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketStateForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI ChatGPT Responses truthful terminal ownership", () => {
  it.each([
    { transport: "sse", status: undefined },
    { transport: "sse", status: "incomplete" },
    { transport: "websocket", status: undefined },
    { transport: "websocket", status: "incomplete" },
  ] as const)(
    "rejects filtered $transport terminals with $status status without leaking blocked text",
    async ({ transport, status }) => {
      const terminal = incompleteTerminal({ transport, reason: "content_filter", status });
      const { events, result, fetchMock } = await runTerminal(terminal, transport);

      expect(events.map((event) => event.type)).toEqual(["start", "error"]);
      expect(result).toMatchObject({
        stopReason: "error",
        responseId: terminal.response.id,
        errorMessage: "Provider incomplete_reason: content_filter",
        content: [],
        usage: { input: 13, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 25 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(transport === "sse" ? 1 : 0);
    },
  );

  it.each([
    { transport: "sse", status: undefined },
    { transport: "sse", status: "incomplete" },
    { transport: "websocket", status: undefined },
    { transport: "websocket", status: "incomplete" },
  ] as const)(
    "preserves truncated $transport text without exposing an unfinished tool ($status status)",
    async ({ transport, status }) => {
      const terminal = incompleteTerminal({ transport, reason: "max_output_tokens", status });
      const { events, result, fetchMock } = await runTerminal(terminal, transport);

      expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
      expect(result).toMatchObject({
        stopReason: "length",
        responseId: terminal.response.id,
        content: [{ type: "text", text: "PROVIDER_PARTIAL" }],
        usage: { input: 13, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 25 },
      });
      expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(transport === "sse" ? 1 : 0);
    },
  );

  it("does not retry a filtered provider WebSocket turn over SSE in automatic mode", async () => {
    const terminal = incompleteTerminal({ transport: "auto", reason: "content_filter" });
    const { events, result, fetchMock } = await runTerminal(terminal, "auto");

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider incomplete_reason: content_filter",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["response.completed", "response.done"] as const)(
    "preserves valid $0 completed aliases and successful usage",
    async (type) => {
      const { events, result } = await runTerminal(
        {
          type,
          response: {
            id: `resp-valid-${type}`,
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_valid",
                role: "assistant",
                content: [{ type: "output_text", text: "VALID" }],
              },
            ],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          },
        },
        "sse",
      );

      expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
      expect(result).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "VALID" }],
      });
    },
  );
});
