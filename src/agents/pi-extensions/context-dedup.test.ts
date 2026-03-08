/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { deduplicateMessages } from "./context-dedup/deduper.js";
import {
  applyReadLineageCompaction,
  applyRepeatFoldCompaction,
  rewriteReadLineageSourcePointers,
} from "./context-dedup/extension.js";
import { findRepeatedSubstrings } from "./context-dedup/lcs-dedup.js";
import { resolveEffectiveDedupSettings } from "./context-dedup/settings.js";

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
    const body =
      "This is the stable message body that should dedup despite timestamp drift.".repeat(3);

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
    const base = "line payload xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20);
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

    const withoutTrailing = base.replace(/\n+$/g, "");
    const result2 = deduplicateMessages(
      [
        { role: "toolResult", content: base },
        { role: "toolResult", content: withoutTrailing },
      ],
      DEDUP_ON,
    );

    expect(String(result2.messages[1].content)).toContain("[1 repeat of content omitted]");
    expect(String(result2.messages[1].content)).toContain("context message #0");
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

    expect(result.messages).toEqual([
      { role: "toolResult", content: [{ type: "image", content: repeated }] },
      { role: "toolResult", content: [{ type: "image", content: repeated }] },
    ]);
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

  it("applies LCS near-duplicate compaction when lcsMode is enabled", () => {
    const sharedPrefix = "prefix-section-".repeat(30);
    const sharedSuffix = "-suffix-section".repeat(30);
    const first = `${sharedPrefix}\n${"alpha-change-".repeat(18)}\n${sharedSuffix}`;
    const second = `${sharedPrefix}\n${"beta-".repeat(8)}\n${sharedSuffix}`;

    const result = deduplicateMessages(
      [
        { role: "toolResult", toolCallId: "read_a", content: first },
        { role: "toolResult", toolCallId: "read_b", content: second },
      ],
      {
        ...DEDUP_ON,
        lcsMode: "on",
        lcsMinSize: 80,
        sizeSimilarityThreshold: 0.5,
      },
    );

    const secondCompressed = String(result.messages[1].content);
    expect(secondCompressed).toContain("[Near-duplicate content trimmed]");
    expect(secondCompressed).toContain("Same as context message #0");
    expect(secondCompressed).toContain("Differing middle");
  });

  it("does not apply LCS near-duplicate compaction when lcsMode is disabled", () => {
    const sharedPrefix = "prefix-section-".repeat(30);
    const sharedSuffix = "-suffix-section".repeat(30);
    const first = `${sharedPrefix}\n${"alpha-change-".repeat(18)}\n${sharedSuffix}`;
    const second = `${sharedPrefix}\n${"beta-".repeat(8)}\n${sharedSuffix}`;

    const result = deduplicateMessages(
      [
        { role: "toolResult", toolCallId: "read_a", content: first },
        { role: "toolResult", toolCallId: "read_b", content: second },
      ],
      {
        ...DEDUP_ON,
        lcsMode: "off",
        lcsMinSize: 80,
      },
    );

    expect(String(result.messages[1].content)).toBe(second);
  });

  it("resolves LCS settings defaults in effective dedup settings", () => {
    const resolved = resolveEffectiveDedupSettings(undefined);
    expect(resolved.lcsMode).toBe("off");
    expect(resolved.lcsMinSize).toBe(50);
    expect(resolved.sizeSimilarityThreshold).toBe(0.5);
  });

  it("handles tiny LCS window configs without stalling", () => {
    const repeated = findRepeatedSubstrings(["aaaaaa", "aaaabb", "aaabaa"], {
      mode: "on",
      minSubstringSize: 1,
      maxSubstringSize: 3,
      refTagSize: 1,
      maxIterations: 10,
    });

    expect(repeated.size).toBeGreaterThan(0);
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

  it("does not overcount trailing newline in read lineage line ranges", () => {
    const lines = Array.from({ length: 10 }, (_, idx) => `line ${idx + 1} :: ${"n".repeat(48)}`);
    const chunk = `${lines.join("\n")}\n`;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nl_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/newline-range.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nl_1",
        content: chunk,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nl_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/newline-range.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nl_2",
        content: chunk,
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const repeatedChunkNote = String(result.messages[3].content);

    expect(repeatedChunkNote).toContain("[Same file chunk already shown earlier]");
    expect(repeatedChunkNote).toContain("Lines: 1-10");
    expect(repeatedChunkNote).not.toContain("Lines: 1-11");
  });

  it("does not let trailing newline push 7-line chunks across full-omit threshold", () => {
    const lines = Array.from({ length: 7 }, (_, idx) => `line ${idx + 1} :: ${"q".repeat(80)}`);
    const chunk = `${lines.join("\n")}\n`;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nl_gate_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/newline-gate.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nl_gate_1",
        content: chunk,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_nl_gate_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/newline-gate.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_nl_gate_2",
        content: chunk,
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);

    expect(String(result.messages[3].content)).toBe(chunk);
    expect(result.stats.fullyOmittedChunks).toBe(0);
  });

  it("keeps read line cursor aligned when array-form read results include header text", () => {
    const baseLines = Array.from(
      { length: 20 },
      (_, idx) => `line ${idx + 1} :: ${"h".repeat(48)}`,
    );
    const changedLines = [...baseLines];
    changedLines[5] = "line 6 changed :: HHHHHHHH";

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_header_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/header-block.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_header_1",
        content: [
          { type: "text", text: "Path: /tmp/header-block.txt" },
          { type: "text", text: baseLines.join("\n") },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_header_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/header-block.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_header_2",
        content: [
          { type: "text", text: "Path: /tmp/header-block.txt" },
          { type: "text", text: changedLines.join("\n") },
        ],
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const compactedFileBlock = String((result.messages[3].content as any[])[1]?.text ?? "");

    expect(compactedFileBlock).toContain("Same as earlier chunk lines 1-20");
    expect(compactedFileBlock).not.toContain("Same as earlier chunk lines 2-21");
  });

  it("supports read lineage compaction for text blocks encoded via parts arrays", () => {
    const baseLines = Array.from(
      { length: 24 },
      (_, idx) => `line ${idx + 1} :: ${"p".repeat(48)}`,
    );
    const changedLines = [...baseLines];
    changedLines[4] = "line 5 changed :: PPPPPPPP";

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_parts_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/parts-block.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_parts_1",
        content: [{ type: "text", parts: [{ type: "text", text: baseLines.join("\n") }] }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_parts_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/parts-block.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_parts_2",
        content: [{ type: "text", parts: [{ type: "text", text: changedLines.join("\n") }] }],
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const compacted = String((result.messages[3].content as any[])[0]?.parts?.[0]?.text ?? "");

    expect(compacted).toContain("[Read delta from earlier chunk]");
    expect(compacted).toContain("lines 5 now read");
  });

  it("does not treat real file chunks that start with Path: as metadata headers", () => {
    const baseFirstBlock = [
      "Path: /tmp/real-content.txt",
      ...Array.from({ length: 19 }, (_, idx) => `line ${idx + 2} :: ${"m".repeat(48)}`),
    ].join("\n");
    const baseSecondBlock = Array.from(
      { length: 20 },
      (_, idx) => `line ${idx + 21} :: ${"m".repeat(48)}`,
    ).join("\n");

    const changedSecondBlock = baseSecondBlock
      .split("\n")
      .map((line, idx) => (idx === 9 ? "line 30 changed :: MMMMMMMM" : line))
      .join("\n");

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_real_path_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/real-content.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_real_path_1",
        content: [
          { type: "text", text: baseFirstBlock },
          { type: "text", text: baseSecondBlock },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_real_path_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/real-content.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_real_path_2",
        content: [
          { type: "text", text: baseFirstBlock },
          { type: "text", text: changedSecondBlock },
        ],
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const compactedSecondBlock = String((result.messages[3].content as any[])[1]?.text ?? "");

    expect(compactedSecondBlock).toContain("lines 30 now read");
    expect(compactedSecondBlock).not.toContain("lines 10 now read");
  });

  it("supports toolUse/functionCall read blocks and toolUseId-linked results", () => {
    const baseLines = Array.from(
      { length: 30 },
      (_, idx) => `line ${idx + 1} :: ${"u".repeat(48)}`,
    );
    const changedLines = [...baseLines];
    changedLines[6] = "line 7 changed :: UUUUUUUU";

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "use_1",
            name: "read",
            input: { path: "/tmp/tooluse-demo.txt", offset: 1 },
          },
        ],
      },
      {
        role: "toolResult",
        toolUseId: "use_1",
        content: baseLines.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "functionCall",
            id: "fn_2",
            name: "read",
            arguments: { path: "/tmp/tooluse-demo.txt", offset: 1 },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "fn_2",
        content: changedLines.join("\n"),
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const deltaText = String(result.messages[3].content);

    expect(deltaText).toContain("[Read delta from earlier chunk]");
    expect(deltaText).toContain("Same as earlier chunk lines 1-30, except:");
    expect(result.stats.partiallyTrimmedChunks).toBe(1);
  });

  it("anchors full repeated chunks to a source with matching full chunk text", () => {
    const baseLines = Array.from(
      { length: 10 },
      (_, idx) => `line ${idx + 1} :: ${"m".repeat(40)}`,
    );
    const updatedLines = [...baseLines];
    updatedLines[0] = `line 1 :: ${"n".repeat(40)}`;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_match_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/matching-chunk.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_match_1",
        content: baseLines.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_match_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/matching-chunk.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_match_2",
        content: updatedLines.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_match_3",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/matching-chunk.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_match_3",
        content: updatedLines.join("\n"),
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const repeatedChunkNote = String(result.messages[5].content);

    expect(repeatedChunkNote).toContain("[Same file chunk already shown earlier]");
    expect(repeatedChunkNote).toContain("Earlier chunk: context message #3");
    expect(repeatedChunkNote).not.toContain("Earlier chunk: context message #1");
  });

  it("selects a full-range lineage source instead of a later partial source", () => {
    const baseLines = Array.from(
      { length: 200 },
      (_, idx) => `line ${idx + 1} :: ${"p".repeat(60)}`,
    );
    const updatedLines = [...baseLines];
    for (let line = 150; line <= 170; line++) {
      updatedLines[line - 1] = `line ${line} updated :: ${"q".repeat(60)}`;
    }
    const newestLines = [...updatedLines];
    newestLines[9] = `line 10 newest :: ${"r".repeat(60)}`;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_range_1",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/range-source.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_range_1",
        content: baseLines.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_range_2",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/range-source.txt", offset: 150 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_range_2",
        content: updatedLines.slice(149, 170).join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_range_3",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/range-source.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_range_3",
        content: updatedLines.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_range_4",
            name: "read",
            arguments: JSON.stringify({ path: "/tmp/range-source.txt", offset: 1 }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_range_4",
        content: newestLines.join("\n"),
      },
    ];

    const result = applyReadLineageCompaction(messages as any[]);
    const deltaText = String(result.messages[7].content);

    expect(deltaText).toContain("[Read delta from earlier chunk]");
    expect(deltaText).toContain("Earlier chunk: context message #5");
    expect(deltaText).not.toContain("Earlier chunk: context message #3");
  });

  it("rewrites dedup pointers that target lineage notes back to root source", () => {
    const fullChunk = "Heartbeat content line ".repeat(20);
    const lineageNote =
      "[Same file chunk already shown earlier]\n" +
      "Path: HEARTBEAT.md\n" +
      "Earlier chunk: context message #0 (toolCallId call_a)\n" +
      "Lines: 1-14";

    const deduped = deduplicateMessages(
      [
        { role: "toolResult", toolCallId: "call_a", content: fullChunk },
        { role: "toolResult", toolCallId: "call_b", content: lineageNote },
        { role: "toolResult", toolCallId: "call_c", content: lineageNote },
      ],
      DEDUP_ON,
    );

    const preRewrite = String(deduped.messages[2].content);
    expect(preRewrite).toContain("Same as context message #1");

    const rewritten = rewriteReadLineageSourcePointers(deduped.messages);
    const postRewrite = String(rewritten[2].content);
    expect(postRewrite).toContain("Same as context message #0");
    expect(postRewrite).not.toContain("Same as context message #1");
  });

  it("rewrites chained dedup pointers with the root block index", () => {
    const rootContent = "root chunk ".repeat(30);
    const intermediatePointer =
      "[1 repeat of content omitted]\n" +
      "Same as context message #0, block #1 (toolCallId call_root).";
    const nestedPointer =
      "[1 repeat of content omitted]\n" +
      "Same as context message #1, block #0 (toolCallId call_mid).";

    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_root",
        content: [
          { type: "text", text: "header" },
          { type: "text", text: rootContent },
        ],
      },
      { role: "toolResult", toolCallId: "call_mid", content: intermediatePointer },
      { role: "toolResult", toolCallId: "call_leaf", content: nestedPointer },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[2].content);

    expect(postRewrite).toContain("Same as context message #0, block #1");
    expect(postRewrite).not.toContain("Same as context message #0, block #0");
    expect(postRewrite).toContain("toolCallId call_root");
    expect(postRewrite).not.toContain("toolCallId call_mid");
  });

  it("preserves block index when dedup pointers hop through lineage notes", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const lineageNote =
      "[Same file chunk already shown earlier]\n" +
      "Path: /tmp/hop.txt\n" +
      "Earlier chunk: context message #0 (toolCallId call_root)\n" +
      "Lines: 1-20";
    const pointerToLineage =
      "[1 repeat of content omitted]\n" +
      "Same as context message #1, block #1 (toolCallId call_lineage).";

    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_root",
        content: [
          { type: "text", text: "header" },
          { type: "text", text: rootChunk },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_lineage",
        content: [
          { type: "text", text: "metadata" },
          { type: "text", text: lineageNote },
        ],
      },
      { role: "toolResult", toolCallId: "call_pointer", content: pointerToLineage },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[2].content);

    expect(postRewrite).toContain("Same as context message #0, block #1");
    expect(postRewrite).not.toContain("Same as context message #0, block #0");
  });

  it("follows lineage notes in non-first blocks when resolving lineage roots", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const compactedLineageNote =
      "[Same file chunk already shown earlier]\n" +
      "Path: /tmp/hop-nonfirst.txt\n" +
      "Earlier chunk: context message #0 (toolCallId call_root)\n" +
      "Lines: 1-20";
    const nestedLineageNote =
      "[Read overlap trimmed]\n" +
      "Path: /tmp/hop-nonfirst.txt\n" +
      "Earlier chunk: context message #1 (toolCallId call_compacted)\n" +
      "Earlier lines omitted: 1-19\n" +
      "New/changed lines 20-20:\nline 20";

    const messages = [
      { role: "toolResult", toolCallId: "call_root", content: rootChunk },
      {
        role: "toolResult",
        toolCallId: "call_compacted",
        content: [
          { type: "text", text: "metadata" },
          { type: "text", text: compactedLineageNote },
        ],
      },
      { role: "toolResult", toolCallId: "call_nested", content: nestedLineageNote },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[2].content);

    expect(postRewrite).toContain("Earlier chunk: context message #0");
    expect(postRewrite).not.toContain("Earlier chunk: context message #1");
  });

  it("rewrites only lineage header fields and preserves matching payload text", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const compactedLineageNote =
      "[Same file chunk already shown earlier]\n" +
      "Path: /tmp/hop-header-only.txt\n" +
      "Earlier chunk: context message #0 (toolCallId call_root)\n" +
      "Lines: 1-20";
    const nestedLineageNote =
      "[Read delta from earlier chunk]\n" +
      "Path: /tmp/hop-header-only.txt\n" +
      "Earlier chunk: context message #1 (toolCallId call_compacted)\n" +
      "Same as earlier chunk lines 1-20, except:\n" +
      "- lines 20 now read:\n" +
      "Earlier chunk: context message #1 (literal file text)";

    const messages = [
      { role: "toolResult", toolCallId: "call_root", content: rootChunk },
      { role: "toolResult", toolCallId: "call_compacted", content: compactedLineageNote },
      { role: "toolResult", toolCallId: "call_nested", content: nestedLineageNote },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[2].content);

    expect(postRewrite).toContain("Earlier chunk: context message #0");
    expect(postRewrite).toContain("Earlier chunk: context message #1 (literal file text)");
  });

  it("rewrites dedup pointer header fields without mutating differing-middle payload", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const intermediatePointer =
      "[1 repeat of content omitted]\n" +
      "Same as context message #0, block #0 (toolCallId call_root).";
    const nearDuplicateNote =
      "[Near-duplicate content trimmed]\n" +
      "Same as context message #1, block #0 (toolCallId call_mid).\n" +
      "Shared prefix 100 chars and suffix 100 chars.\n" +
      "Differing middle (49 chars):\n" +
      "Same as context message #1, block #0 (literal text).";

    const messages = [
      { role: "toolResult", toolCallId: "call_root", content: rootChunk },
      { role: "toolResult", toolCallId: "call_mid", content: intermediatePointer },
      { role: "toolResult", toolCallId: "call_leaf", content: nearDuplicateNote },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[2].content);

    expect(postRewrite).toContain("Same as context message #0, block #0 (toolCallId call_root).");
    expect(postRewrite).toContain("Same as context message #1, block #0 (literal text).");
  });

  it("resolves dedup chains through near-duplicate inline metadata pointers", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const intermediatePointer =
      "[1 repeat of content omitted]\n" +
      "Same as context message #0, block #0 (toolCallId call_root).";
    const nearDuplicateInline =
      "[Near-duplicate content trimmed]\n" +
      "Same as context message #1, block #0 (toolCallId call_mid). Shared prefix 120 chars and suffix 120 chars.\n" +
      "Differing middle (10 chars):\nHELLO_WORLD";
    const pointerToNearDuplicate =
      "[1 repeat of content omitted]\n" +
      "Same as context message #2, block #0 (toolCallId call_leaf).";

    const messages = [
      { role: "toolResult", toolCallId: "call_root", content: rootChunk },
      { role: "toolResult", toolCallId: "call_mid", content: intermediatePointer },
      { role: "toolResult", toolCallId: "call_leaf", content: nearDuplicateInline },
      { role: "toolResult", toolCallId: "call_chain", content: pointerToNearDuplicate },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[3].content);

    expect(postRewrite).toContain("Same as context message #0, block #0");
    expect(postRewrite).not.toContain("Same as context message #2, block #0");
  });

  it("ignores pointer-like payload lines when resolving lineage roots", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const lineageWithPayloadPointer =
      "[Read delta from earlier chunk]\n" +
      "Path: /tmp/root-parse-scope.txt\n" +
      "Earlier chunk: context message #0 (toolCallId call_root)\n" +
      "Same as earlier chunk lines 1-20, except:\n" +
      "- lines 20 now read:\n" +
      "Same as context message #2, block #0.";
    const nestedLineage =
      "[Read overlap trimmed]\n" +
      "Path: /tmp/root-parse-scope.txt\n" +
      "Earlier chunk: context message #1 (toolCallId call_mid)\n" +
      "Earlier lines omitted: 1-19\n" +
      "New/changed lines 20-20:\nline 20";

    const messages = [
      { role: "toolResult", toolCallId: "call_root", content: rootChunk },
      { role: "toolResult", toolCallId: "call_mid", content: lineageWithPayloadPointer },
      { role: "toolResult", toolCallId: "call_leaf", content: nestedLineage },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[2].content);

    expect(postRewrite).toContain("Earlier chunk: context message #0");
    expect(postRewrite).not.toContain("Earlier chunk: context message #2");
  });

  it("rewrites pointers in parts blocks while ignoring payload pointer-like lines", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const lineageWithPayloadPointer =
      "[Read delta from earlier chunk]\n" +
      "Path: /tmp/root-parse-parts.txt\n" +
      "Earlier chunk: context message #0 (toolCallId call_root)\n" +
      "Same as earlier chunk lines 1-20, except:\n" +
      "- lines 20 now read:\n" +
      "Same as context message #2, block #0.";
    const pointerToLineage =
      "[1 repeat of content omitted]\n" +
      "Same as context message #1, block #0 (toolCallId call_mid).";

    const messages = [
      { role: "toolResult", toolCallId: "call_root", content: rootChunk },
      {
        role: "toolResult",
        toolCallId: "call_mid",
        content: [{ type: "text", parts: [{ type: "text", text: lineageWithPayloadPointer }] }],
      },
      {
        role: "toolResult",
        toolCallId: "call_leaf",
        content: [{ type: "text", parts: [{ type: "text", text: pointerToLineage }] }],
      },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String((rewritten[2].content as any[])[0]?.parts?.[0]?.text ?? "");

    expect(postRewrite).toContain("Same as context message #0, block #0");
    expect(postRewrite).not.toContain("Same as context message #2, block #0");
  });

  it("clamps block index when lineage hops land on string source messages", () => {
    const rootChunk = "root chunk line ".repeat(20);
    const lineageNote =
      "[Same file chunk already shown earlier]\n" +
      "Path: /tmp/hop-string.txt\n" +
      "Earlier chunk: context message #0 (toolCallId call_root)\n" +
      "Lines: 1-20";
    const pointerToLineage =
      "[1 repeat of content omitted]\n" +
      "Same as context message #1, block #1 (toolCallId call_lineage).";

    const messages = [
      { role: "toolResult", toolCallId: "call_root", content: rootChunk },
      {
        role: "toolResult",
        toolCallId: "call_lineage",
        content: [
          { type: "text", text: "metadata" },
          { type: "text", text: lineageNote },
        ],
      },
      { role: "toolResult", toolCallId: "call_pointer", content: pointerToLineage },
    ];

    const rewritten = rewriteReadLineageSourcePointers(messages as any[]);
    const postRewrite = String(rewritten[2].content);

    expect(postRewrite).toContain("Same as context message #0, block #0");
    expect(postRewrite).not.toContain("Same as context message #0, block #1");
  });

  it("rewrites nested lineage source pointers to original dedup source", () => {
    const original = Array.from({ length: 40 }, (_, idx) => `line ${idx + 1} :: ${"z".repeat(48)}`);
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

    const deduped = deduplicateMessages(lineage.messages, DEDUP_ON);
    const sourceMessageText = String(deduped.messages[5].content);
    expect(sourceMessageText).toContain("Same as context message #1");

    const preRewriteDeltaText = String(deduped.messages[7].content);
    expect(preRewriteDeltaText).toContain("[Read delta from earlier chunk]");
    expect(preRewriteDeltaText).toContain("context message #5");

    const rewritten = rewriteReadLineageSourcePointers(deduped.messages);
    const postRewriteDeltaText = String(rewritten[7].content);
    expect(postRewriteDeltaText).toContain("context message #1");
    expect(postRewriteDeltaText).not.toContain("context message #5");
  });

  it("folds repeated multiline tool output runs", () => {
    const repeatedLine =
      "ERROR: ld.so: object '/usr/lib/libtcmalloc.so.4' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.";

    const messages = [
      {
        role: "toolResult",
        content: [repeatedLine, repeatedLine, repeatedLine, repeatedLine, repeatedLine].join("\n"),
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);
    const text = String(folded.messages[0].content);

    expect(text).toContain("[repeats 4 more times]");
    expect(text).toContain(repeatedLine);
    expect(folded.stats.collapsedRuns).toBe(1);
    expect(folded.stats.omittedCopies).toBe(4);
  });

  it("skips repeat-fold on protected lineage source messages", () => {
    const repeatedLine =
      "ERROR: ld.so: object '/usr/lib/libtcmalloc.so.4' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.";

    const messages = [
      {
        role: "toolResult",
        content: [repeatedLine, repeatedLine, repeatedLine, repeatedLine, repeatedLine].join("\n"),
      },
      {
        role: "toolResult",
        content: [repeatedLine, repeatedLine, repeatedLine, repeatedLine].join("\n"),
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[], {
      protectedMessageIndexes: new Set([0]),
    });

    expect(String(folded.messages[0].content)).toBe(messages[0]?.content);
    expect(String(folded.messages[1].content)).toContain("[repeats 3 more times]");
    expect(folded.stats.collapsedRuns).toBe(1);
    expect(folded.stats.omittedCopies).toBe(3);
  });

  it("does not fold multiline runs that differ only by indentation", () => {
    const indented = "    setting = some_value_with_whitespace_significance()";
    const nonIndented = "setting = some_value_with_whitespace_significance()";

    const messages = [
      {
        role: "toolResult",
        content: [indented, nonIndented].join("\n"),
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);

    expect(String(folded.messages[0].content)).toBe([indented, nonIndented].join("\n"));
    expect(folded.stats.collapsedRuns).toBe(0);
    expect(folded.stats.omittedCopies).toBe(0);
  });

  it("preserves indentation distinctions when folding repeated multiline patterns", () => {
    const indented = "    setting = some_value_with_whitespace_significance()";
    const nonIndented = "setting = some_value_with_whitespace_significance()";

    const messages = [
      {
        role: "toolResult",
        content: [indented, nonIndented, indented, nonIndented].join("\n"),
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);
    const text = String(folded.messages[0].content);

    expect(text).toContain(indented);
    expect(text).toContain(nonIndented);
    expect(text).toContain("[repeats 1 more times]");
    expect(folded.stats.collapsedRuns).toBe(1);
    expect(folded.stats.omittedCopies).toBe(1);
  });

  it("folds repeated sentence runs in single-line tool output", () => {
    const repeatedSentence =
      "ERROR: ld.so: object '/usr/lib/libtcmalloc.so.4' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.";
    const singleLine = `${repeatedSentence} ${repeatedSentence} ${repeatedSentence}`;

    const messages = [
      {
        role: "toolResult",
        content: singleLine,
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);
    const text = String(folded.messages[0].content);

    expect(text).toContain("[repeats 2 more times]");
    expect(text).toContain(repeatedSentence);
    expect(folded.stats.collapsedRuns).toBe(1);
    expect(folded.stats.omittedCopies).toBe(2);
  });

  it("folds delimiter-free repeating block patterns", () => {
    const a = "ALPHA_BLOCK_xxxxxxxxxxxxxxxxxxxxxx";
    const b = "BRAVO_BLOCK_yyyyyyyyyyyyyyyyyyyyyy";
    const c = "CHARLIE_BLOCK_zzzzzzzzzzzzzzzzzzzz";
    const d = "DELTA_BLOCK_qqqqqqqqqqqqqqqqqqqqqq";

    const pattern = `${a}${b}${c}${d}`;
    const input = `${pattern}${pattern}${pattern}`;

    const messages = [
      {
        role: "toolResult",
        content: input,
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);
    const text = String(folded.messages[0].content);

    expect(text).toContain("[repeats 2 more times]");
    expect(text).toContain(pattern.slice(0, 80));
    expect(folded.stats.collapsedRuns).toBeGreaterThanOrEqual(1);
    expect(folded.stats.omittedCopies).toBeGreaterThanOrEqual(2);
  });

  it("folds periodic terminal-style frame cycles in one-line text", () => {
    const frameA = "[1G[J[35m◒[39m  [38;5;209mComplete sign-in in browser…[39m";
    const frameB = "[1G[J[35m◐[39m  [38;5;209mComplete sign-in in browser…[39m.";
    const frameC = "[1G[J[35m◓[39m  [38;5;209mComplete sign-in in browser…[39m..";
    const frameD = "[1G[J[35m◑[39m  [38;5;209mComplete sign-in in browser…[39m...";

    const input = `${frameA}${frameB}${frameC}${frameD}${frameA}${frameB}${frameC}${frameD}`;

    const messages = [
      {
        role: "toolResult",
        content: input,
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);
    const text = String(folded.messages[0].content);

    expect(text).toContain("[repeats 1 more times]");
    expect(text).toContain("Complete sign-in in browser");
    expect(folded.stats.collapsedRuns).toBeGreaterThanOrEqual(1);
    expect(folded.stats.omittedCopies).toBeGreaterThanOrEqual(1);
  });

  it("folds terminal-style frame cycles embedded in multiline tool output", () => {
    const frameA = "[1G[J[35m◒[39m  [38;5;209mComplete sign-in in browser…[39m";
    const frameB = "[1G[J[35m◐[39m  [38;5;209mComplete sign-in in browser…[39m.";
    const frameC = "[1G[J[35m◓[39m  [38;5;209mComplete sign-in in browser…[39m..";
    const frameD = "[1G[J[35m◑[39m  [38;5;209mComplete sign-in in browser…[39m...";

    const spinnerBlob = `${frameA}${frameB}${frameC}${frameD}`.repeat(3);
    const input = `OpenClaw onboarding\n${spinnerBlob}\n\nProcess still running.`;

    const messages = [
      {
        role: "toolResult",
        content: input,
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);
    const text = String(folded.messages[0].content);

    expect(text).toContain("[repeats 2 more times]");
    expect(text).toContain("OpenClaw onboarding");
    expect(text).toContain("Process still running.");
    expect(folded.stats.collapsedRuns).toBeGreaterThanOrEqual(1);
    expect(folded.stats.omittedCopies).toBeGreaterThanOrEqual(2);
  });

  it("still folds repeated lines when message also contains existing repeat markers", () => {
    const repeatedLine =
      "ERROR: ld.so: object '/usr/lib/libtcmalloc.so.4' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.";

    const prefix = `${repeatedLine}\n`.repeat(9).trimEnd();
    const suffix =
      "\n\nPREVIEW:\n[1G[J[35m◐[39m  [38;5;209mComplete sign-in in browser…[39m [repeats 7 more times]";

    const messages = [
      {
        role: "toolResult",
        content: `${prefix}${suffix}`,
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);
    const text = String(folded.messages[0].content);

    expect(text).toContain("[repeats 8 more times]");
    expect(text).toContain("PREVIEW:");
    expect(text).toContain("[repeats 7 more times]");
    expect(folded.stats.collapsedRuns).toBeGreaterThanOrEqual(1);
    expect(folded.stats.omittedCopies).toBeGreaterThanOrEqual(8);
  });

  it("does not fold synthetic pointer notes", () => {
    const note =
      "[1 repeat of content omitted]\n" +
      "Same as context message #12, block #0 (toolCallId call_1).\n" +
      "[1 repeat of content omitted]\n" +
      "Same as context message #12, block #0 (toolCallId call_1).";

    const messages = [
      {
        role: "toolResult",
        content: note,
      },
    ];

    const folded = applyRepeatFoldCompaction(messages as any[]);

    expect(String(folded.messages[0].content)).toBe(note);
    expect(folded.stats.collapsedRuns).toBe(0);
    expect(folded.stats.omittedCopies).toBe(0);
  });
});
