import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";
import { streamOpenAICodexResponses } from "./openai-chatgpt-responses.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function completedSseResponse(responseId = "resp_test"): Response {
  const event = {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("streamOpenAICodexResponses retry handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("retries transport errors whose Error message is unavailable", async () => {
    const transportError = new Error("temporary transport failure");
    Object.defineProperty(transportError, "message", {
      configurable: true,
      value: undefined,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(completedSseResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as ReturnType<typeof setTimeout>;
    });

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      maxRetries: 1,
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
