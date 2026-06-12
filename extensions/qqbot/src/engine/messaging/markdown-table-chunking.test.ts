// QQ Bot Markdown chunking tests cover message-boundary table repair.
import { describe, expect, it } from "vitest";
import {
  chunkQQBotMarkdownText,
  createQQBotMarkdownChunker,
  type QQBotBaseMarkdownChunker,
} from "./markdown-table-chunking.js";

const baseChunker: QQBotBaseMarkdownChunker = (text, limit) =>
  text.length <= limit ? [text] : [text.slice(0, limit), text.slice(limit)];

describe("chunkQQBotMarkdownText", () => {
  it("prefixes continuation chunks with the active table header", () => {
    const text = [
      "| Id | Value |",
      "|---:|---|",
      "| 1 | alpha |",
      "| 2 | beta |",
      "| 3 | gamma |",
    ].join("\n");

    expect(chunkQQBotMarkdownText(text, 45, baseChunker)).toEqual([
      ["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"),
      ["| Id | Value |", "|---:|---|", "| 2 | beta |"].join("\n"),
      ["| Id | Value |", "|---:|---|", "| 3 | gamma |"].join("\n"),
    ]);
  });

  it("keeps table state across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"), 120),
    ).toEqual([["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n")]);
    expect(chunker.chunkText(["| 2 | beta |", "| 3 | gamma |"].join("\n"), 120)).toEqual([
      ["| Id | Value |", "|---:|---|", "| 2 | beta |", "| 3 | gamma |"].join("\n"),
    ]);
  });

  it("does not prefix after a table is closed by a blank line", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    chunker.chunkText(["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n") + "\n\n", 120);

    expect(chunker.chunkText("| not | a continuation |", 120)).toEqual([
      "| not | a continuation |",
    ]);
  });

  it("renders an oversized table row as fields instead of splitting the row", () => {
    const text = [
      "| Id | Error | Retry |",
      "|---|---|---|",
      `| 003 | ${"当前无错误信息，处理流程正常运行".repeat(8)} | 当前重试次数为零 |`,
      "| 004 | ok | zero |",
    ].join("\n");

    const chunks = chunkQQBotMarkdownText(text, 80, baseChunker);

    expect(chunks[0]).toContain("Id: 003");
    expect(chunks[0]).toContain("Error:");
    expect(chunks.some((chunk) => chunk.startsWith("| 当前无错误信息"))).toBe(false);
    expect(chunks.at(-1)).toBe(
      ["| Id | Error | Retry |", "|---|---|---|", "| 004 | ok | zero |"].join("\n"),
    );
  });

  it("buffers a table row fragment across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(
        ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
        160,
      ),
    ).toEqual([["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n")]);

    expect(chunker.chunkText("| 5 | generatemonthly_sales", 160)).toEqual([]);
    expect(chunker.chunkText("_by_region | ok |", 160)).toEqual([
      [
        "| Id | Function | Status |",
        "|---:|---|---|",
        "| 5 | generatemonthly_sales_by_region | ok |",
      ].join("\n"),
    ]);
  });

  it("buffers a pipe-terminated row until it reaches the table column count", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(
        ["| Id | Time | Owner | Note |", "|---:|---|---|---|", "| 16 | 40ms | He | ok |"].join(
          "\n",
        ),
        200,
      ),
    ).toEqual([
      ["| Id | Time | Owner | Note |", "|---:|---|---|---|", "| 16 | 40ms | He | ok |"].join("\n"),
    ]);

    expect(chunker.chunkText("| 17 | 100ms |", 200)).toEqual([]);
    expect(chunker.chunkText("Lin | daily cap |", 200)).toEqual([
      [
        "| Id | Time | Owner | Note |",
        "|---:|---|---|---|",
        "| 17 | 100ms | Lin | daily cap |",
      ].join("\n"),
    ]);
  });

  it("flushes an unfinished table row fragment as plain fields", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    chunker.chunkText(
      ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
      160,
    );
    expect(chunker.chunkText("| 10 | analyzeerror_patterns | 无需重试", 160)).toEqual([]);

    expect(chunker.flushPendingText(160)).toEqual([
      ["Id: 10", "Function: analyzeerror_patterns", "Status: 无需重试"].join("\n"),
    ]);
  });

  it("does not emit malformed pipe fragments without table context", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText("| 5 | reportbuilder.ts | generatemonthly_sales", 160)).toEqual([]);
    expect(chunker.flushPendingText(160)).toEqual(["5 reportbuilder.ts generatemonthly_sales"]);
  });
});
