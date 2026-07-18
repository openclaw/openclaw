import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("streamOpenAICodexResponses websocket blob transport", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

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
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  } satisfies Context;

  it("reconnects once when the websocket connection limit is reached", async () => {
    let connections = 0;
    class ConnectionLimitWebSocket extends EventTarget {
      private readonly limitReached = connections++ === 0;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        const event = this.limitReached
          ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
          : {
              type: "response.completed",
              response: {
                id: "resp_ws",
                status: "completed",
                output: [],
                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
              },
            };
        queueMicrotask(() => {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        });
      }

      close(): void {}
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "websocket",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connections).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rotates cached websockets before the backend connection age limit", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-03T00:00:00Z");
    vi.setSystemTime(startedAt);
    let connections = 0;
    const sentConnectionIds: number[] = [];

    class AgedWebSocket extends EventTarget {
      readonly connectionId = ++connections;
      readyState = 1;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        sentConnectionIds.push(this.connectionId);
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.completed",
                response: {
                  id: `resp_${this.connectionId}`,
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
                },
              }),
            }),
          );
        });
      }

      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", AgedWebSocket);
    const apiKey = createJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    });
    const sessionId = "aged-session";

    await streamOpenAICodexResponses(model, context, {
      apiKey,
      sessionId,
      transport: "websocket-cached",
    }).result();
    vi.setSystemTime(new Date(startedAt.getTime() + 56 * 60 * 1000));
    await streamOpenAICodexResponses(model, context, {
      apiKey,
      sessionId,
      transport: "websocket-cached",
    }).result();

    expect(sentConnectionIds).toEqual([1, 2]);
    expect(connections).toBe(2);
  });

  it("rejects oversized blob-like websocket messages before reading them", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    class OversizedBlobWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: {
                arrayBuffer,
                size: 16 * 1024 * 1024 + 1,
              },
            }),
          );
        });
      }

      close(): void {}
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("WebSocket", OversizedBlobWebSocket);
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "websocket",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Codex WebSocket message exceeded size limit");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
