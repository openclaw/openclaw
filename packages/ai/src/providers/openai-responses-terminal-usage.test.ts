// Canonical Responses terminal mapping is shared by the package processor and the agent transport.
import { describe, expect, it } from "vitest";
import { mapResponsesTerminalUsage } from "./openai-responses-terminal-usage.js";

describe("mapResponsesTerminalUsage", () => {
  it("keeps totalTokens at the bucket sum when clamping outgrows the reported total", () => {
    // cached_tokens exceeding input_tokens clamps input to 0, so the reported total understates it.
    expect(
      mapResponsesTerminalUsage({
        input_tokens: 2,
        output_tokens: 5,
        total_tokens: 7,
        input_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({
      input: 0,
      output: 5,
      cacheRead: 4,
      cacheWrite: 0,
      contextUsage: { state: "unavailable" },
      totalTokens: 9,
    });
  });

  it("rejects an output-absent context snapshot whose total is below its input", () => {
    expect(mapResponsesTerminalUsage({ input_tokens: 30, total_tokens: 29 })?.contextUsage).toEqual(
      {
        state: "unavailable",
      },
    );
  });

  it("accepts an output-absent context snapshot whose total covers its input", () => {
    expect(mapResponsesTerminalUsage({ input_tokens: 30, total_tokens: 30 })?.contextUsage).toEqual(
      { state: "available", promptTokens: 30, totalTokens: 30 },
    );
  });
});
