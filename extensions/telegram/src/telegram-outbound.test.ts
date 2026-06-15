// Telegram tests cover telegram outbound plugin behavior.
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { describe, expect, it } from "vitest";
import { splitTelegramHtmlChunks } from "./format.js";
import { telegramOutbound } from "./outbound-adapter.js";
import { clearTelegramRuntime } from "./runtime.js";

function markdownTable(columns: number): string {
  return [
    Array.from({ length: columns }, (_, index) => `H${index + 1}`).join(" | "),
    Array.from({ length: columns }, () => "---").join(" | "),
    Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | "),
  ]
    .map((row) => `| ${row} |`)
    .join("\n");
}

describe("telegramPlugin outbound", () => {
  it("uses static outbound contract when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    const text = `${"hello\n".repeat(1200)}tail`;
    const expected = chunkMarkdownTextWithMode(`${"hello  \n".repeat(1200)}tail`, 32_768, "length");

    expect(telegramOutbound.chunker?.(text, 32_768)).toEqual(expected);
    expect(telegramOutbound.deliveryMode).toBe("direct");
    expect(telegramOutbound.chunkerMode).toBe("markdown");
    expect(telegramOutbound.chunkedTextFormatting).toBeUndefined();
    expect(telegramOutbound.textChunkLimit).toBe(32_768);
    expect(telegramOutbound.presentationCapabilities?.limits?.text?.markdownDialect).toBe(
      "markdown",
    );
    expect(telegramOutbound.sanitizeText).toBeUndefined();
    expect(telegramOutbound.pollMaxOptions).toBe(10);
  });

  it("preserves explicit HTML parse mode before chunking", () => {
    clearTelegramRuntime();
    const text = "<b>hi</b>";

    expect(telegramOutbound.chunker?.(text, 4000, { formatting: { parseMode: "HTML" } })).toEqual(
      splitTelegramHtmlChunks(text, 4000),
    );
    expect(telegramOutbound.chunker?.(text, 4000)).toEqual([text]);
  });

  it("keeps markdown tables intact for rich message parsing", () => {
    clearTelegramRuntime();
    const text = ["| Name | Value |", "|------|-------|", "| A | 1 |"].join("\n");

    const chunks = telegramOutbound.chunker?.(text, 4000, {
      formatting: { tableMode: "bullets" },
    });

    expect(chunks).toEqual([text]);
  });

  it("wraps wide markdown tables before rich message parsing", () => {
    clearTelegramRuntime();
    const text = markdownTable(21);

    const chunks = telegramOutbound.chunker?.(text, 32_768);

    expect(chunks).toEqual(["```\n" + text + "\n```"]);
  });

  it("wraps only wide markdown tables outside fences", () => {
    clearTelegramRuntime();
    const fencedTable = markdownTable(25);
    const outsideTable = markdownTable(21);
    const text = ["Before", "~~~", fencedTable, "~~~", "After", outsideTable].join("\n");

    const chunks = telegramOutbound.chunker?.(text, 32_768);

    expect(chunks).toEqual([
      ["Before", "~~~", fencedTable, "~~~", "After", "```", outsideTable, "```"].join("\n"),
    ]);
  });

  it("chunks rich markdown by Telegram's block limit", () => {
    clearTelegramRuntime();
    const text = Array.from({ length: 900 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n");

    const chunks = telegramOutbound.chunker?.(text, 32_768);

    expect(chunks).toHaveLength(2);
    expect(
      chunks?.every(
        (chunk) => chunk.split(/\n[\t ]*\n+/).filter((block) => block.trim()).length <= 500,
      ),
    ).toBe(true);
    expect(chunks?.join("\n\n")).toBe(text);
  });

  it("chunks rich markdown headings by Telegram's block limit", () => {
    clearTelegramRuntime();
    const text = Array.from({ length: 600 }, (_, index) => `# Heading ${index + 1}`).join("\n");

    const chunks = telegramOutbound.chunker?.(text, 32_768);

    expect(chunks).toHaveLength(2);
    expect(chunks?.at(0)?.match(/^# /gm)).toHaveLength(500);
    expect(chunks?.at(1)?.match(/^# /gm)).toHaveLength(100);
    expect(chunks?.join("\n")).toBe(text);
  });

  it("keeps long rich markdown lists intact", () => {
    clearTelegramRuntime();
    const text = Array.from({ length: 600 }, (_, index) => `- Item ${index + 1}`).join("\n");

    const chunks = telegramOutbound.chunker?.(text, 32_768);

    expect(chunks).toEqual([text]);
  });

  it("keeps tall rich markdown tables intact", () => {
    clearTelegramRuntime();
    const text = [
      "| Name | Value |",
      "| --- | --- |",
      ...Array.from({ length: 600 }, (_, index) => `| Row ${index + 1} | ${index + 1} |`),
    ].join("\n");

    const chunks = telegramOutbound.chunker?.(text, 32_768);

    expect(chunks).toEqual([text]);
  });
});
