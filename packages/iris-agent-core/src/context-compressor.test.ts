/**
 * Unit tests for age-based tool result compression.
 */
import { describe, expect, it } from "vitest";
import { compressAgedToolResults } from "./context-compressor.js";
import type { AgentMessage } from "./types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function userMsg(text = "hi"): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMsg(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as AgentMessage;
}

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "read_file",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("compressAgedToolResults", () => {
  it("does nothing when there are fewer turns than ageTurns", () => {
    const longText = "x".repeat(1000);
    const msgs: AgentMessage[] = [userMsg(), assistantMsg(), toolResult(longText)];
    // ageTurns=3, only 1 user message → nothing to compress
    const result = compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 200 });
    expect(result).toHaveLength(3);
    const tr = result[2] as { content: { text: string }[] };
    expect(tr.content[0]?.text).toBe(longText);
  });

  it("does not compress tool results in recent turns", () => {
    const longText = "y".repeat(500);
    // 3 turns, ageTurns=3 → all protected
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantMsg(),
      toolResult(longText),
      userMsg("t2"),
      assistantMsg(),
      toolResult(longText),
      userMsg("t3"),
      assistantMsg(),
      toolResult(longText),
    ];
    const result = compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 200 });
    // All 3 ToolResults should be unchanged
    for (const idx of [2, 5, 8]) {
      const tr = result[idx] as { content: { text: string }[] };
      expect(tr.content[0]?.text).toBe(longText);
    }
  });

  it("compresses tool results in turns older than ageTurns", () => {
    const longText = "z".repeat(500);
    // 4 turns, ageTurns=2 → turns 1 and 2 are old, turns 3 and 4 are recent
    const msgs: AgentMessage[] = [
      userMsg("t1"), // index 0 — old
      assistantMsg(), // index 1
      toolResult(longText), // index 2 — should compress
      userMsg("t2"), // index 3 — old
      assistantMsg(), // index 4
      toolResult(longText), // index 5 — should compress
      userMsg("t3"), // index 6 — recent (protected)
      assistantMsg(), // index 7
      toolResult(longText), // index 8 — recent
      userMsg("t4"), // index 9 — recent
      assistantMsg(), // index 10
      toolResult(longText), // index 11 — recent
    ];
    const result = compressAgedToolResults(msgs, { ageTurns: 2, maxChars: 100 });

    // Old tool results at index 2 and 5 should be compressed
    for (const idx of [2, 5]) {
      const tr = result[idx] as { content: { text: string }[] };
      const text = tr.content[0]?.text ?? "";
      expect(text.length).toBeLessThan(longText.length);
      expect(text).toContain("aged-out");
    }

    // Recent tool results at index 8 and 11 should be unchanged
    for (const idx of [8, 11]) {
      const tr = result[idx] as { content: { text: string }[] };
      expect(tr.content[0]?.text).toBe(longText);
    }
  });

  it("leaves short tool results unchanged even when old", () => {
    const shortText = "short";
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantMsg(),
      toolResult(shortText), // old but short — should not compress
      userMsg("t2"),
      assistantMsg(),
      toolResult("x".repeat(500)), // recent
      userMsg("t3"),
      assistantMsg(),
      toolResult("x".repeat(500)), // recent
      userMsg("t4"),
      assistantMsg(),
    ];
    const result = compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 200 });
    const tr = result[2] as { content: { text: string }[] };
    expect(tr.content[0]?.text).toBe(shortText);
  });

  it("does not mutate the original messages array", () => {
    const longText = "m".repeat(500);
    const msgs: AgentMessage[] = [
      userMsg("t1"),
      assistantMsg(),
      toolResult(longText),
      userMsg("t2"),
      assistantMsg(),
      userMsg("t3"),
      assistantMsg(),
      userMsg("t4"),
      assistantMsg(),
    ];
    const original = msgs.map((m) => JSON.parse(JSON.stringify(m)));
    compressAgedToolResults(msgs, { ageTurns: 3, maxChars: 50 });
    expect(JSON.stringify(msgs)).toBe(JSON.stringify(original));
  });
});
