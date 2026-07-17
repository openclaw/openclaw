import { describe, expect, it } from "vitest";
import type { SessionTreeEntry } from "../types.js";
import { estimateTokens, findCutPoint } from "./compaction.js";

type EstimateInput = Parameters<typeof estimateTokens>[0];

const CJK_TEXT = "你".repeat(160);

function messageEntry(message: EstimateInput, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(index).toISOString(),
    message,
  };
}

describe("CJK compaction token accounting", () => {
  it("weights each textual message shape", () => {
    const messages: EstimateInput[] = [
      { role: "user", content: CJK_TEXT },
      { role: "user", content: [{ type: "text", text: CJK_TEXT }] },
      { role: "assistant", content: [{ type: "text", text: CJK_TEXT }] },
      { role: "assistant", content: [{ type: "thinking", thinking: CJK_TEXT }] },
      { role: "custom", content: CJK_TEXT },
      { role: "toolResult", content: CJK_TEXT },
      { role: "toolResult", content: [{ type: "toolResult", content: CJK_TEXT }] },
      { role: "bashExecution", command: CJK_TEXT, output: "" },
      { role: "branchSummary", summary: CJK_TEXT },
      { role: "compactionSummary", summary: CJK_TEXT },
    ] as EstimateInput[];

    for (const message of messages) {
      expect(estimateTokens(message)).toBe(160);
    }
  });

  it("weights tool-call names and arguments", () => {
    const tokens = estimateTokens({
      role: "assistant",
      content: [{ type: "toolCall", name: CJK_TEXT, arguments: {} }],
    } as EstimateInput);

    expect(tokens).toBe(161);
  });

  it("counts CJK Extension B code points once", () => {
    expect(estimateTokens({ role: "user", content: "𠀀".repeat(160) } as EstimateInput)).toBe(160);
  });

  it("selects the same cut point as equivalent ASCII text", () => {
    const cjkEntries = Array.from({ length: 4 }, (_, index) =>
      messageEntry({ role: "user", content: CJK_TEXT } as EstimateInput, index),
    );
    const asciiEntries = Array.from({ length: 4 }, (_, index) =>
      messageEntry({ role: "user", content: "a".repeat(640) } as EstimateInput, index),
    );

    const cjkResult = findCutPoint(cjkEntries, 0, cjkEntries.length, 100);
    const asciiResult = findCutPoint(asciiEntries, 0, asciiEntries.length, 100);

    expect(cjkResult.firstKeptEntryIndex).toBe(3);
    expect(cjkResult).toEqual(asciiResult);
  });
});
