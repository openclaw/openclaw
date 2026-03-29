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

  it("accepts the Codex responses transport pair", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(true);
  });

  it("normalizes provider and modelApi before matching", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "  OpenAI  ",
        modelApi: " OpenAI-Responses ",
      }),
    ).toBe(true);
  });

  it("rejects mismatched OpenAI websocket transport pairs", () => {
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
