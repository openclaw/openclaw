import { describe, expect, it } from "vitest";
import { deduplicateMessages } from "./context-dedup/deduper.js";
import { applyReadLineageCompaction } from "./context-dedup/extension.js";

const DEDUP_ON = {
  mode: "on",
  minContentSize: 32,
  refTagFormat: "unicode",
} as const;

describe("context-dedup", () => {
  it("deduplicates repeated toolResult text object blocks with plain pointers", () => {
    const repeated = "A".repeat(200);

    const messages = [
      {
        role: "toolResult",
        toolCallId: "read_1",
        content: [{ type: "text", text: repeated }],
      },
      {
        role: "toolResult",
        toolCallId: "read_2",
        content: [{ type: "text", text: repeated }],
      },
    ];

    const result = deduplicateMessages(messages as any[], DEDUP_ON);

    expect(Object.keys(result.refTable)).toHaveLength(0);
    expect((result.messages[0].content[0] as { type: string; text: string }).text).toBe(repeated);

    const second = (result.messages[1].content[0] as { type: string; text: string }).text;
    expect(second).toContain("[1 repeat of content omitted]");
    expect(second).toContain("context message #0");
    expect(second).toContain("toolCallId read_1");
  });

  it("deduplicates repeated non-tool messages with plain pointers", () => {
    const repeated = "B".repeat(220);

    const result = deduplicateMessages(
      [
        { role: "user", content: repeated },
        { role: "assistant", content: repeated },
        { role: "user", content: repeated },
      ],
      DEDUP_ON,
    );

    expect(result.messages[0].content).toBe(repeated);

    const second = String(result.messages[1].content);
    const third = String(result.messages[2].content);
    expect(second).toContain("[2 repeats of content omitted]");
    expect(third).toContain("[2 repeats of content omitted]");
    expect(second).toContain("context message #0");
    expect(third).toContain("context message #0");
  });

  it("deduplicates timestamped non-tool messages by normalized body", () => {
    const body = "This is the stable message body that should dedup despite timestamp drift.".repeat(3);

    const result = deduplicateMessages(
      [
        { role: "user", content: `[Tue 2026-03-03 13:16 EST] ${body}` },
        { role: "user", content: `[Tue 2026-03-03 13:17 EST] ${body}` },
        { role: "user", content: `[Tue 2026-03-03 13:18 EST] ${body}` },
      ],
      DEDUP_ON,
    );

    expect(String(result.messages[0].content)).toContain("13:16 EST");
    expect(String(result.messages[1].content)).toContain("[2 repeats of content omitted]");
    expect(String(result.messages[2].content)).toContain("[2 repeats of content omitted]");
  });

  it("preserves scalar string content shape after replacement", () => {
    const repeated = "C".repeat(180);

    const result = deduplicateMessages(
      [
        { role: "toolResult", content: repeated },
        { role: "toolResult", content: repeated },
      ],
      DEDUP_ON,
    );

    expect(typeof result.messages[0].content).toBe("string");
    expect(typeof result.messages[1].content).toBe("string");
  });

  it("ignores non-text typed blocks", () => {
    const repeated = "D".repeat(220);

    const result = deduplicateMessages(
      [
        { role: "toolResult", content: [{ type: "image", content: repeated }] },
        { role: "toolResult", content: [{ type: "image", content: repeated }] },
      ],
      DEDUP_ON,
    );

    expect(Object.keys(result.refTable)).toHaveLength(0);
  });

  it("compresses near-duplicate read chunks into line-based delta notes", () => {
    const baseLines = Array.from({ length: 20 }, (_, idx) => `line ${idx + 1}`);
    const changedLines = [...baseLines];
    changedLines[2] = "line 3 changed";
    changedLines[3] = "line 4 changed";
    changedLines[9] = "line 10 changed";
    changedLines[16] = "line 17 changed";

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/demo.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_1",
        content: baseLines.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/demo.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_2",
        content: changedLines.join("\n"),
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const deltaText = String(result.messages[3].content);

    expect(deltaText).toContain("[Read delta from earlier chunk]");
    expect(deltaText).toContain("Same as earlier chunk lines 1-20, except:");
    expect(deltaText).toContain("lines 3-4 now read");
    expect(deltaText).toContain("lines 10 now read");
    expect(deltaText).toContain("lines 17 now read");
    expect(result.stats.partiallyTrimmedChunks).toBe(1);
  });

  it("limits read delta notes to at most three hunks", () => {
    const baseLines = Array.from({ length: 30 }, (_, idx) => `line ${idx + 1}`);
    const changedLines = [...baseLines];
    changedLines[2] = "line 3 changed";
    changedLines[5] = "line 6 changed";
    changedLines[8] = "line 9 changed";
    changedLines[19] = "line 20 changed";
    changedLines[22] = "line 23 changed";

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_merge_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/demo-merge.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_merge_1",
        content: baseLines.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_merge_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/demo-merge.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_merge_2",
        content: changedLines.join("\n"),
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const deltaText = String(result.messages[3].content);
    const hunkCount = (deltaText.match(/now read:/g) || []).length;

    expect(deltaText).toContain("[Read delta from earlier chunk]");
    expect(hunkCount).toBeLessThanOrEqual(3);
  });
});
