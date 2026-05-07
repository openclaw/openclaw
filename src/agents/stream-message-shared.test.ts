import { describe, expect, it } from "vitest";
import {
  STREAM_ERROR_FALLBACK_TEXT,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";

const model = {
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  id: "anthropic.claude-3-haiku-20240307-v1:0",
};

describe("buildStreamErrorAssistantMessage", () => {
  it("never returns an empty content array", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content.length).toBeGreaterThan(0);
  });

  it("places only the sentinel in content and never echoes the raw error text", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    // Replay-visible content must be the canonical sentinel — replaying raw
    // provider error strings could leak hostnames/metadata to the model and
    // turn them into a prompt-injection surface.
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    expect(JSON.stringify(message.content)).not.toContain("internal.example.com");
    // The detailed error remains available in the peer field for clients/UIs.
    expect(message.errorMessage).toBe("stream aborted by upstream host=internal.example.com");
    expect(message.stopReason).toBe("error");
  });

  it("uses the same sentinel when errorMessage is blank", () => {
    const message = buildStreamErrorAssistantMessage({ model, errorMessage: "   " });
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    // Original errorMessage is preserved verbatim for clients that surface it.
    expect(message.errorMessage).toBe("   ");
  });

  it("surfaces a safe billing hint when the provider rejects the token budget", () => {
    const message = buildStreamErrorAssistantMessage({
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "moonshotai/kimi-k2.6",
      },
      errorMessage:
        "402 This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 643. To increase, visit https://openrouter.ai/settings/credits",
    });

    expect(message.content).toEqual([
      {
        type: "text",
        text: "[model unavailable: billing/credits] openrouter (moonshotai/kimi-k2.6) cannot run with the current API key balance. Requested up to 4096 tokens, but the account can only afford 643. Add credits, lower maxTokens, or switch models.",
      },
    ]);
    expect(JSON.stringify(message.content)).not.toContain("settings/credits");
    expect(message.errorMessage).toContain("settings/credits");
  });
});
