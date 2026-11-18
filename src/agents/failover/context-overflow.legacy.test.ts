import { describe, expect, it } from "vitest";
import {
  extractObservedOverflowTokenCount,
  isCompactionFailureError,
} from "../embedded-agent-helpers/context-overflow-observation.js";

function expectMessageMatches(
  matcher: (message: string) => boolean,
  samples: readonly string[],
  expected: boolean,
) {
  for (const sample of samples) {
    expect(matcher(sample), sample).toBe(expected);
  }
}

describe("isCompactionFailureError", () => {
  it.each([
    {
      name: "matches compaction overflow failures",
      samples: [
        'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        "auto-compaction failed due to context overflow",
        "Compaction failed: prompt is too long",
        "Summarization failed: context window exceeded for this request",
      ],
      expected: true,
    },
  ])("$name", ({ samples, expected }) => {
    expectMessageMatches(isCompactionFailureError, samples, expected);
  });
});

describe("extractObservedOverflowTokenCount", () => {
  it("extracts provider-reported prompt token counts", () => {
    expect(
      extractObservedOverflowTokenCount(
        '400 {"type":"error","error":{"message":"prompt is too long: 277403 tokens > 200000 maximum"}}',
      ),
    ).toBe(277403);
    expect(
      extractObservedOverflowTokenCount("Context window exceeded: requested 12000 tokens"),
    ).toBe(12000);
    expect(
      extractObservedOverflowTokenCount(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 145000 tokens.",
      ),
    ).toBe(145000);
    expect(
      extractObservedOverflowTokenCount(
        "400 The prompt is too long: 203557, model maximum context length: 196607",
      ),
    ).toBe(203557);
    expect(
      extractObservedOverflowTokenCount(
        "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      ),
    ).toBe(291351);
    expect(
      extractObservedOverflowTokenCount(
        "input length and max_tokens exceed context limit (i.e 156321 + 48384 > 200000)",
      ),
    ).toBe(204705);
    expect(
      extractObservedOverflowTokenCount(
        "input length and `max_tokens` exceed context limit: 176312 + 32000 > 200000",
      ),
    ).toBe(208312);
  });

  it("returns undefined when overflow counts are not present", () => {
    expect(extractObservedOverflowTokenCount("Prompt too large for this model")).toBeUndefined();
    expect(
      extractObservedOverflowTokenCount(
        "The prompt is too long: 203557 characters, model maximum context length: 196607",
      ),
    ).toBeUndefined();
    expect(extractObservedOverflowTokenCount("rate limit exceeded")).toBeUndefined();
  });
});
