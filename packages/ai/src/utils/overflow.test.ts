import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { isContextOverflow, matchesContextOverflowMessage } from "./overflow.js";

type ContextUsage = AssistantMessage["usage"]["contextUsage"];

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

function successfulMessage(contextUsage?: ContextUsage): AssistantMessage {
  return {
    ...errorMessage(""),
    usage: {
      ...createZeroUsage(),
      input: 12,
      output: 15_104,
      cacheRead: 1_100_000,
      cacheWrite: 93_130,
      ...(contextUsage ? { contextUsage } : {}),
      totalTokens: 1_208_246,
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
    "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 28897 `inputs` tokens and 3872 `max_new_tokens`",
    "Input validation error: `inputs` must have less than 32768 tokens. Given: 40000",
    "Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input.",
    "400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]",
  ])("detects %s", (text) => {
    expect(isContextOverflow(errorMessage(text), 262_144)).toBe(true);
  });

  it("does not compact an output-only TGI validation error", () => {
    const text = "Input validation error: `max_new_tokens` must be <= 4096. Given: 8192";
    expect(isContextOverflow(errorMessage(text))).toBe(false);
  });
  it("recognizes the provider input-length wording in the strict failover scope", () => {
    const text = "input length 14295 tokens exceeds the model limit";
    expect(matchesContextOverflowMessage(text, "failover-explicit")).toBe(true);
  });
  it.each<[ContextUsage, number, boolean]>([
    [{ state: "available", promptTokens: 148_874, totalTokens: 163_978 }, 1_000_000, false],
    [{ state: "unavailable" }, 1_000_000, false],
    // input + cacheRead is below this window; cacheWrite must also count.
    [undefined, 1_150_000, true],
  ])("uses context %j before billing usage", (context, window, overflow) => {
    expect(isContextOverflow(successfulMessage(context), window)).toBe(overflow);
  });
});
