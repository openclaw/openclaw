// Covers ChatGPT Responses websocket transport frame decoding.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

function createTestJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("streamOpenAICodexResponses websocket frames", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("rejects a websocket binary frame with invalid UTF-8 bytes", async () => {
    class CorruptFrameWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        const frame = new Uint8Array([
          ...new TextEncoder().encode('{"type":"response.completed","response":{"id":"resp_ws'),
          0xff,
          ...new TextEncoder().encode(
            '","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
          ),
        ]);
        queueMicrotask(() => {
          this.dispatchEvent(Object.assign(new Event("message"), { data: frame }));
        });
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", CorruptFrameWebSocket);
    vi.stubGlobal("fetch", vi.fn());

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "websocket",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Invalid Codex WebSocket JSON");
  });
});
