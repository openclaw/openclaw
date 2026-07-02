// QQ Bot Markdown chunking tests cover message-boundary table repair.
import { describe, expect, it } from "vitest";
import {
  chunkQQBotMarkdownText,
  createQQBotMarkdownChunker,
  testing,
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

  it("keeps a possible table header until a later separator confirms the table", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText("| Id | Value |", 120)).toEqual([]);
    expect(
      chunker.chunkText(["|---:|---|", "| 1 | alpha |", "| 2 | beta |"].join("\n"), 120),
    ).toEqual([["| Id | Value |", "|---:|---|", "| 1 | alpha |", "| 2 | beta |"].join("\n")]);
  });

  it("confirms a table when the separator uses one or two dashes, not only three", () => {
    // GFM delimiter cells need only one or more dashes; a sub-3-dash separator previously failed
    // recognition, so the header and all rows but the last were silently dropped on send.
    for (const separator of ["|--|--|", "|-|-|", "|:--|--:|"]) {
      const text = ["| Id | Value |", separator, "| 1 | alpha |", "| 2 | beta |"].join("\n");
      expect(chunkQQBotMarkdownText(text, 200, baseChunker)).toEqual([text]);
    }
  });

  it("flushes a possible table header as text when the next block is not a separator", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText("| maybe | header |", 120)).toEqual([]);
    expect(chunker.chunkText("plain continuation", 120)).toEqual([
      ["| maybe | header |", "plain continuation"].join("\n"),
    ]);
  });

  it("does not prefix after a table is closed by a blank line", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    chunker.chunkText(["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n") + "\n\n", 120);

    expect(chunker.chunkText("| not | a continuation |", 120)).toEqual([]);
    expect(chunker.flushPendingText(120)).toEqual(["| not | a continuation |"]);
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

  it("keeps fenced code blocks self-contained across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText(["```ts", "const a = 1;"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText(["const b = 2;", "```"].join("\n"), 200)).toEqual([
      ["```ts", "const a = 1;", "const b = 2;", "```"].join("\n"),
    ]);
  });

  it("joins a fenced code line split across block deliveries", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(["```python", "    pool_timeout: float = 30."].join("\n"), 200),
    ).toEqual([]);
    expect(
      chunker.chunkText(["0", "    def get_dsn(self) -> str:", "```"].join("\n"), 200),
    ).toEqual([
      ["```python", "    pool_timeout: float = 30.0", "    def get_dsn(self) -> str:", "```"].join(
        "\n",
      ),
    ]);
  });

  it("keeps long fenced chunks under the QQ markdown byte safety limit", () => {
    const lines = Array.from(
      { length: 90 },
      (_, index) =>
        `        value_${String(index).padStart(3, "0")} = "这是一行用于测试 QQ markdown 不要接近平台截断线的 Python 代码"`,
    );
    const text = ["```python", ...lines].join("\n");
    const chunks = chunkQQBotMarkdownText(text, 5000, baseChunker);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(3600);
      expect(chunk.startsWith("```python\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }
  });

  it("allows ASCII fenced chunks past the old 1800 character fallback", () => {
    const lines = Array.from(
      { length: 90 },
      (_, index) =>
        `        value_${String(index).padStart(3, "0")} = "ascii markdown budget should use bytes not a short character cap"`,
    );
    const chunks = chunkQQBotMarkdownText(["```python", ...lines].join("\n"), 5000, baseChunker);

    expect(chunks.some((chunk) => chunk.length > 1800)).toBe(true);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(3600);
      expect(chunk.startsWith("```python\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }
  });

  it("keeps fenced formula blocks self-contained across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText(["```math", "E = mc^2"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText(["a^2 + b^2 = c^2", "```"].join("\n"), 200)).toEqual([
      ["```math", "E = mc^2", "a^2 + b^2 = c^2", "```"].join("\n"),
    ]);
  });

  it("splits fenced code chunks between lines for every viable limit", () => {
    const firstLine = `const value001 = "用于测试代码行保持完整";`;
    const secondLine = `const value002 = "用于测试代码行保持完整";`;
    const singleLineFenceLength = Buffer.byteLength(["```ts", firstLine, "```"].join("\n"));
    const wholeFenceLength = Buffer.byteLength(["```ts", firstLine, secondLine, "```"].join("\n"));

    for (let limit = singleLineFenceLength; limit < wholeFenceLength; limit++) {
      const chunker = createQQBotMarkdownChunker(baseChunker);
      const chunks = [
        ...chunker.chunkText(["```ts", firstLine, secondLine].join("\n"), limit),
        ...chunker.flushPendingText(limit),
      ];

      expect(chunks).toEqual([
        ["```ts", firstLine, "```"].join("\n"),
        ["```ts", secondLine, "```"].join("\n"),
      ]);
    }
  });

  it("handles prose before and after a table split at row boundaries", () => {
    const text = [
      "前置说明第一段，长度足够触发普通文本先发送。",
      "前置说明第二段继续解释。",
      "| Id | Value |",
      "|---:|---|",
      "| 1 | alpha |",
      "| 2 | beta |",
      "后置说明第一段，表格结束后继续普通文字。",
      "后置说明第二段。",
    ].join("\n");

    // Front prose merges with the table (both fit under 3600 bytes), and the
    // trailing prose becomes its own chunk because no table/fence follows it.
    expect(chunkQQBotMarkdownText(text, 180, baseChunker)).toEqual([
      [
        "前置说明第一段，长度足够触发普通文本先发送。",
        "前置说明第二段继续解释。",
        "| Id | Value |",
        "|---:|---|",
        "| 1 | alpha |",
        "| 2 | beta |",
      ].join("\n"),
      ["后置说明第一段，表格结束后继续普通文字。", "后置说明第二段。"].join("\n"),
    ]);
  });

  it("merges a short paragraph with a short table when total bytes fit the QQ limit", () => {
    const paragraph = "Short intro paragraph that wraps the table below.";
    const tableText = ["| Id | Value |", "|---:|---|", "| 1 | alpha |", "| 2 | beta |"].join("\n");
    const text = `${paragraph}\n${tableText}`;

    const chunks = chunkQQBotMarkdownText(text, 5000, baseChunker);

    expect(chunks).toEqual([text]);
  });

  it("merges a short paragraph with a short fenced block when total bytes fit the QQ limit", () => {
    const paragraph = "Brief intro before the code block.";
    const fenceText = ["```ts", "const a = 1;", "const b = 2;", "```"].join("\n");
    const text = `${paragraph}\n${fenceText}`;

    const chunks = chunkQQBotMarkdownText(text, 5000, baseChunker);

    expect(chunks).toEqual([text]);
  });

  it("does not merge a paragraph with a table that would push the chunk past 3600 bytes", () => {
    // A 3000-byte paragraph plus a table whose combined UTF-8 byte length
    // would exceed the 3600-byte safety limit. The paragraph must therefore
    // be emitted as its own chunk, separate from the table.
    const paragraph = "x".repeat(3000);
    const tableText = ["| Id | Value |", "|---:|---|", `| 1 | ${"y".repeat(1500)} |`].join("\n");

    const chunks = chunkQQBotMarkdownText(`${paragraph}\n${tableText}`, 5000, baseChunker);

    expect(chunks).toContain(paragraph);
    expect(chunks).toContain(tableText);
    expect(chunks.find((c) => c.includes(paragraph) && c.includes("| Id |"))).toBeUndefined();
  });

  it("does not merge a paragraph with a fenced block that would push the chunk past 3600 bytes", () => {
    const paragraph = "x".repeat(3000);
    const fenceLine = "y".repeat(1500);
    const fenceText = ["```ts", fenceLine, "```"].join("\n");

    const chunks = chunkQQBotMarkdownText(`${paragraph}\n${fenceText}`, 5000, baseChunker);

    expect(chunks).toContain(paragraph);
    expect(chunks).toContain(fenceText);
    expect(chunks.find((c) => c.includes(paragraph) && c.includes("```ts"))).toBeUndefined();
  });

  it("emits only prose unchanged when no table or fence is present", () => {
    const text = "First paragraph line.\nSecond paragraph line.";
    expect(chunkQQBotMarkdownText(text, 5000, baseChunker)).toEqual([text]);
  });

  it("emits only a table unchanged when no surrounding prose exists", () => {
    const text = ["| Id | Value |", "|---:|---|", "| 1 | alpha |", "| 2 | beta |"].join("\n");
    expect(chunkQQBotMarkdownText(text, 5000, baseChunker)).toEqual([text]);
  });

  it("emits only a fenced block unchanged when no surrounding prose exists", () => {
    const text = ["```ts", "const a = 1;", "```"].join("\n");
    expect(chunkQQBotMarkdownText(text, 5000, baseChunker)).toEqual([text]);
  });

  it("emits a paragraph with no trailing table or fence inside chunkText itself", () => {
    // A paragraph that does not border a table or fence must not wait for a
    // future structural block; it is emitted as its own chunk before chunkText
    // returns, so flushPendingText has nothing left to flush.
    const chunker = createQQBotMarkdownChunker((text) => [text]);
    const chunks = chunker.chunkText("Paragraph that ends without any table or fence.", 5000);
    expect(chunks).toEqual(["Paragraph that ends without any table or fence."]);
    expect(chunker.flushPendingText(5000)).toEqual([]);
  });

  it("falls back to the base chunker when a single oversized paragraph exceeds 3600 bytes", () => {
    const text = "x".repeat(4000);
    const chunks = chunkQQBotMarkdownText(text, 5000, baseChunker);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(3600);
    }
  });
});

describe("table-cell splitting", () => {
  it("treats a backslash-escaped pipe as literal cell content, not a delimiter", () => {
    // GFM: `\|` inside a cell is a literal "|", so this row has two cells, not
    // three. Splitting on every "|" previously mis-counted columns, so the
    // oversized-row fallback rendered the trailing content under the wrong header.
    expect(testing.splitTableCells("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("leaves ordinary rows unchanged", () => {
    expect(testing.splitTableCells("| a | b |")).toEqual(["a", "b"]);
  });

  it("unescapes a literal backslash and still splits on the following pipe", () => {
    expect(testing.splitTableCells("| a \\\\ | b |")).toEqual(["a \\", "b"]);
  });

  it("handles escaped pipes in partial (unterminated) rows", () => {
    expect(testing.splitPartialTableCells("| a \\| b")).toEqual(["a | b"]);
  });
});
