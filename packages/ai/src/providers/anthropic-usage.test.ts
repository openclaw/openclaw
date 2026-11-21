import { describe, expect, it } from "vitest";
import { createZeroUsage } from "../usage.test-support.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  readAnthropicCacheWriteUsage,
  readLastAnthropicIterationUsage,
} from "./anthropic-usage.js";

const buckets = (values?: readonly [number?, number?]) =>
  values && {
    ephemeral_5m_input_tokens: values[0],
    ephemeral_1h_input_tokens: values[1],
  };
const iteration = (
  type: string,
  input: number,
  output: number,
  write: number,
  cache?: unknown,
) => ({
  type,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: write,
  cache_creation: cache,
});

describe("Anthropic usage", () => {
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
  it("rejects a final iteration with incomplete cache usage", () => {
    expect(
      readLastAnthropicIterationUsage({
        iterations: [{ type: "message", input_tokens: 12, output_tokens: 15_104 }],
      }),
    ).toEqual({ state: "invalid" });
  });
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
  it("carries both reported buckets through start and delta while omitted breakdowns preserve them", () => {
    const usage = createZeroUsage();
    const start = applyAnthropicMessageStartUsage(usage, {
      input_tokens: 10,
      output_tokens: 0,
      cache_creation_input_tokens: 10,
      cache_creation: buckets([6, 4]),
    });
    expect(usage).toMatchObject({ cacheWrite5m: 6, cacheWrite1h: 4 });
    applyAnthropicMessageDeltaUsage(
      usage,
      {
        cache_creation_input_tokens: 20,
        cache_creation: buckets([12, 8]),
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
    ["start fallback", [6, 4], undefined, undefined, undefined, [6, 4]],
    ["top-level fallback", undefined, [6, 4], undefined, undefined, [6, 4]],
    ["summed buckets", undefined, undefined, [6, 4], [12, 8], [18, 12]],
    ["zero overrides one", undefined, [6, 4], [0], undefined, [0, 4]],
    ["absent stays absent", undefined, undefined, undefined, [undefined, 0], [undefined, 0]],
  ] as const)(
    "%s across compaction iterations",
    (_name, startTopLevel, topLevel, first, second, expected) => {
      const usage = createZeroUsage();
      const start = applyAnthropicMessageStartUsage(usage, {
        input_tokens: 10,
        output_tokens: 0,
        cache_creation_input_tokens: 10,
        cache_creation: buckets(startTopLevel),
      });
      applyAnthropicMessageDeltaUsage(
        usage,
        {
          cache_creation: buckets(topLevel),
          iterations: [
            iteration("compaction", 10, 2, 10, buckets(first)),
            iteration("message", 5, 3, 20, buckets(second)),
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
      });
      for (const [index, key] of ["cacheWrite5m", "cacheWrite1h"].entries()) {
        if (expected[index] === undefined) {
          expect(usage).not.toHaveProperty(key);
        } else {
          expect(usage).toHaveProperty(key, expected[index]);
        }
      }
    },
  );
});
