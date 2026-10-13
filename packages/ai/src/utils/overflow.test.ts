import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { isContextOverflow, matchesContextOverflowMessage } from "./overflow.js";

function errorMessage(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: createZeroUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: 1,
  };
}

function successfulMessage(
  contextUsage?: AssistantMessage["usage"]["contextUsage"],
): AssistantMessage {
  return {
    ...errorMessage(""),
    usage: {
      input: 12,
      output: 15_104,
      cacheRead: 1_100_000,
      cacheWrite: 93_130,
      ...(contextUsage ? { contextUsage } : {}),
      totalTokens: 1_208_246,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    errorMessage: undefined,
  };
}

describe("provider overflow messages", () => {
  it.each([
    { type: "provider_refusal", overflow: false },
    { type: "provider_fallback", overflow: true },
  ])("preserves $type when the error text mentions overflow", ({ type, overflow }) => {
    const message = errorMessage("prompt is too long: 1200 tokens > 1000 maximum");
    message.diagnostics = [{ type, timestamp: 1 }];
    expect(isContextOverflow(message, 1000)).toBe(overflow);
  });

  it.each([
    "Context window exceeded: estimated input 35137 leaves only 0 output tokens within the 32768-token context.",
    "Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input.",
  ])("detects %s", (text) => {
    expect(isContextOverflow(errorMessage(text), 262_144)).toBe(true);
  });
});

describe("scoped overflow messages", () => {
  it("recognizes the provider input-length wording in the strict failover scope", () => {
    expect(
      matchesContextOverflowMessage(
        "input length 14295 tokens exceeds the model limit",
        "failover-explicit",
      ),
    ).toBe(true);
  });
});

describe("usage-based overflow", () => {
  it("prefers an available context snapshot over aggregate billing usage", () => {
    expect(
      isContextOverflow(
        successfulMessage({
          state: "available",
          promptTokens: 148_874,
          totalTokens: 163_978,
        }),
        1_000_000,
      ),
    ).toBe(false);
  });

  it("does not infer overflow from aggregate billing when context is unavailable", () => {
    expect(isContextOverflow(successfulMessage({ state: "unavailable" }), 1_000_000)).toBe(false);
  });

  it("counts cache-write tokens toward the context when no snapshot is available", () => {
    // input + cacheRead alone is 1_100_012, under this window; the 93_130 cache-write
    // tokens are prompt tokens too, and providers that report them separately keep
    // them out of `input`. Omitting the bucket silently under-counts the context.
    expect(isContextOverflow(successfulMessage(), 1_150_000)).toBe(true);
  });
});
