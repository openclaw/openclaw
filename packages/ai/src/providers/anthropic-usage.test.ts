import { describe, expect, it } from "vitest";
import { createZeroUsage } from "../usage.test-support.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  readAnthropicCacheWriteUsage,
  readLastAnthropicIterationUsage,
} from "./anthropic-usage.js";

describe("readAnthropicCacheWriteUsage", () => {
  it("keeps a valid bucket when its sibling is absent or malformed", () => {
    expect(
      readAnthropicCacheWriteUsage({
        cache_creation: {
          ephemeral_5m_input_tokens: "malformed",
          ephemeral_1h_input_tokens: 12,
        },
      }),
    ).toEqual({ cacheWrite1h: 12 });
    expect(readAnthropicCacheWriteUsage({})).toEqual({});
  });
});

describe("readLastAnthropicIterationUsage", () => {
  it("rejects a final iteration with incomplete cache usage", () => {
    expect(
      readLastAnthropicIterationUsage({
        iterations: [
          {
            type: "message",
            input_tokens: 12,
            output_tokens: 15_104,
          },
        ],
      }),
    ).toEqual({ state: "invalid" });
  });
});

describe("applyAnthropicMessageDeltaUsage", () => {
  it("settles usage after zero placeholders when the provider never writes cache", () => {
    const usage = createZeroUsage();
    const start = applyAnthropicMessageStartUsage(usage, { input_tokens: 0, output_tokens: 0 });

    applyAnthropicMessageDeltaUsage(
      usage,
      { input_tokens: 1635, output_tokens: 2, cache_read_input_tokens: 128 },
      start,
    );

    expect(usage).toMatchObject({
      totalTokens: 1765,
      contextUsage: { state: "available", promptTokens: 1763, totalTokens: 1765 },
    });
  });
});
