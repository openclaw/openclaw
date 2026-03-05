import { describe, expect, it } from "vitest";
import { deduplicateMessages } from "./context-dedup/deduper.js";
import { applyReadLineageCompaction, rewriteReadLineageSourcePointers } from "./context-dedup/extension.js";

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

  it("normalizes trailing newlines when matching duplicate payloads", () => {
    const base = `${"line payload xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20)}`;
    const withExtraTrailing = `${base}\n\n`;

    const result = deduplicateMessages(
      [
        { role: "toolResult", content: withExtraTrailing },
        { role: "toolResult", content: base },
      ],
      DEDUP_ON,
    );

    expect(String(result.messages[0].content)).toBe(withExtraTrailing);
    expect(String(result.messages[1].content)).toContain("[1 repeat of content omitted]");
    expect(String(result.messages[1].content)).toContain("context message #0");
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

  it("deduplicates equivalent nested text-parts blocks", () => {
    const repeated = "nested payload ".repeat(40);

    const result = deduplicateMessages(
      [
        { role: "toolResult", content: [{ type: "text", text: repeated }] },
        {
          role: "toolResult",
          content: [
            {
              type: "text",
              parts: [{ type: "text", text: repeated }],
            },
          ],
        },
      ],
      DEDUP_ON,
    );

    expect(JSON.stringify(result.messages[1].content)).toContain("[1 repeat of content omitted]");
    expect(JSON.stringify(result.messages[1].content)).toContain("context message #0");
  });

  it("keeps protected lineage source messages expanded", () => {
    const repeated = "E".repeat(260);

    const result = deduplicateMessages(
      [
        { role: "toolResult", toolCallId: "read_a", content: repeated },
        { role: "toolResult", toolCallId: "read_b", content: repeated },
        { role: "toolResult", toolCallId: "read_c", content: repeated },
      ],
      DEDUP_ON,
      { protectedMessageIndexes: new Set([1]) },
    );

    expect(String(result.messages[1].content)).toBe(repeated);
    expect(String(result.messages[2].content)).toContain("Same as context message #0");
  });

  it("compresses near-duplicate read chunks into line-based delta notes", () => {
    const baseLines = Array.from(
      { length: 40 },
      (_, idx) => `line ${idx + 1} :: ${"x".repeat(48)}`,
    );
    const changedLines = [...baseLines];
    changedLines[2] = "line 3 changed :: XXXXXXXX";
    changedLines[3] = "line 4 changed :: XXXXXXXX";
    changedLines[9] = "line 10 changed :: XXXXXXXX";
    changedLines[16] = "line 17 changed :: XXXXXXXX";

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
    expect(deltaText).toContain("Same as earlier chunk lines 1-40, except:");
    expect(deltaText).toContain("lines 3-4 now read");
    expect(deltaText).toContain("lines 10 now read");
    expect(deltaText).toContain("lines 17 now read");
    expect(result.stats.partiallyTrimmedChunks).toBe(1);
    expect(result.protectedSourceMessageIndexes.has(1)).toBe(true);
  });

  it("limits read delta notes to at most three hunks", () => {
    const baseLines = Array.from(
      { length: 60 },
      (_, idx) => `line ${idx + 1} :: ${"y".repeat(48)}`,
    );
    const changedLines = [...baseLines];
    changedLines[2] = "line 3 changed :: YYYYYYYY";
    changedLines[5] = "line 6 changed :: YYYYYYYY";
    changedLines[8] = "line 9 changed :: YYYYYYYY";
    changedLines[19] = "line 20 changed :: YYYYYYYY";
    changedLines[22] = "line 23 changed :: YYYYYYYY";

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

  it("rewrites nested lineage source pointers to original dedup source", () => {
    const original = Array.from(
      { length: 40 },
      (_, idx) => `line ${idx + 1} :: ${"z".repeat(48)}`,
    );
    const variant = Array.from(
      { length: 40 },
      (_, idx) => `variant ${idx + 1} :: ${"q".repeat(48)}`,
    );
    const finalVariant = [...original];
    finalVariant[39] = "line 40 changed :: ZZZZZZZZ";

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nest_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/nested-demo.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nest_1",
        content: original.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nest_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/nested-demo.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nest_2",
        content: variant.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nest_3",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/nested-demo.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nest_3",
        content: original.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nest_4",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/nested-demo.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nest_4",
        content: finalVariant.join("\n"),
      },
    ];

    const lineage = applyReadLineageCompaction(messages as any[]);

    const deduped = deduplicateMessages(lineage.messages as any[], DEDUP_ON);
    const sourceMessageText = String(deduped.messages[5].content);
    expect(sourceMessageText).toContain("Same as context message #1");

    const preRewriteDeltaText = String(deduped.messages[7].content);
    expect(preRewriteDeltaText).toContain("[Read delta from earlier chunk]");
    expect(preRewriteDeltaText).toContain("context message #5");

    const rewritten = rewriteReadLineageSourcePointers(deduped.messages as any[]);
    const postRewriteDeltaText = String(rewritten[7].content);
    expect(postRewriteDeltaText).toContain("context message #1");
    expect(postRewriteDeltaText).not.toContain("context message #5");
  });
});
