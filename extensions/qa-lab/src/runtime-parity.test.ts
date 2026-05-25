import { describe, expect, it } from "vitest";
import { openclawRuntimeParityCell, type RuntimeParityCell } from "./runtime-parity.js";

function makeCell(runtime: RuntimeParityCell["runtime"]): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: "",
    toolCalls: [],
    finalText: "",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    wallClockMs: 0,
    bootStateLines: [],
  };
}

describe("runtime parity compatibility", () => {
  it("reads deprecated pi cells from persisted summaries", () => {
    const legacyCell = makeCell("openclaw");

    expect(
      openclawRuntimeParityCell({
        pi: legacyCell,
        codex: makeCell("codex"),
      }),
    ).toBe(legacyCell);
  });
});
