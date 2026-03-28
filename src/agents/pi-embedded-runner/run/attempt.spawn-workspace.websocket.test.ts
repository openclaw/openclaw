import { describe, expect, it } from "vitest";
import { shouldUseOpenAIWebSocketTransport } from "./attempt.thread-helpers.js";

describe("openai websocket transport selection", () => {
  it("accepts the direct OpenAI responses transport pair", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    ).toBe(true);
  });

  it("rejects the Codex responses transport pair (chatgpt.com has no WS endpoint)", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(false);
  });

  it("rejects mismatched or non-OpenAI transport pairs", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "anthropic",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });
});
