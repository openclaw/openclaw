import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import { isConfiguredContextSizeOverflowError, isContextOverflow } from "./overflow.js";

function errorMessage(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: 1,
  };
}

describe("configured context size overflow", () => {
  it.each([
    "400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
    "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
  ])("detects %s", (text) => {
    expect(isConfiguredContextSizeOverflowError(text)).toBe(true);
    expect(isContextOverflow(errorMessage(text), 256_000)).toBe(true);
  });
});
