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

describe("reported Anthropic TTL buckets", () => {
  it("carries both reported buckets through start and delta while omitted breakdowns preserve them", () => {
    const usage = createZeroUsage();
    const start = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 10,
      output_tokens: 0,
      cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
    });
    expect(usage).toMatchObject({ cacheWrite5m: 6, cacheWrite1h: 4 });
    applyAnthropicMessageDeltaUsage(
      usage,
      {
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 },
      },
      start,
    );
    applyAnthropicMessageDeltaUsage(usage, { output_tokens: 2 }, start);
    expect(usage).toMatchObject({ cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8 });
    const unreported = createZeroUsage();
    applyAnthropicMessageStartUsage(unreported, { input_tokens: 10, output_tokens: 0 });
    applyAnthropicMessageDeltaUsage(unreported, { output_tokens: 2 }, undefined);
    expect(unreported).not.toHaveProperty("cacheWrite5m");
    expect(unreported).not.toHaveProperty("cacheWrite1h");
  });

  it.each([
    {
      name: "omitted iteration breakdowns preserve message-start buckets",
      startTopLevel: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
      topLevel: undefined,
      first: undefined,
      second: undefined,
      expected: { cacheWrite5m: 6, cacheWrite1h: 4 },
    },
    {
      name: "omitted iteration breakdowns preserve top-level buckets",
      topLevel: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
      first: undefined,
      second: undefined,
      expected: { cacheWrite5m: 6, cacheWrite1h: 4 },
    },
    {
      name: "reported iteration breakdowns sum both buckets",
      topLevel: undefined,
      first: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
      second: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 },
      expected: { cacheWrite5m: 18, cacheWrite1h: 12 },
    },
    {
      name: "reported zero overrides a top-level bucket without replacing its omitted sibling",
      topLevel: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
      first: { ephemeral_5m_input_tokens: 0 },
      second: undefined,
      expected: { cacheWrite5m: 0, cacheWrite1h: 4 },
    },
    {
      name: "reported one-hour zero leaves an unreported five-minute bucket absent",
      topLevel: undefined,
      first: undefined,
      second: { ephemeral_1h_input_tokens: 0 },
      expected: { cacheWrite1h: 0 },
    },
  ])(
    "$name across compaction iterations",
    ({ startTopLevel, topLevel, first, second, expected }) => {
      const usage = createZeroUsage();
      const start = applyAnthropicMessageStartUsage(usage, {
        input_tokens: 10,
        output_tokens: 0,
        cache_creation_input_tokens: 10,
        cache_creation: startTopLevel,
      });
      applyAnthropicMessageDeltaUsage(
        usage,
        {
          cache_creation: topLevel,
          iterations: [
            {
              type: "compaction",
              input_tokens: 10,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 10,
              cache_creation: first,
            },
            {
              type: "message",
              input_tokens: 5,
              output_tokens: 3,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 20,
              cache_creation: second,
            },
          ],
        },
        start,
      );
      expect(usage).toMatchObject({
        input: 15,
        output: 5,
        cacheRead: 0,
        cacheWrite: 30,
        totalTokens: 50,
        contextUsage: { state: "available", promptTokens: 25, totalTokens: 28 },
        ...expected,
      });
      for (const key of ["cacheWrite5m", "cacheWrite1h"] as const) {
        if (!(key in expected)) {
          expect(usage).not.toHaveProperty(key);
        }
      }
    },
  );
});
