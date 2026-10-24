import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "../../packages/markdown-core/src/tables.js";
import { EmbeddedBlockChunker, type BlockChunkMetadata } from "./embedded-agent-block-chunker.js";

describe("streamed oversized Markdown tables", () => {
  const rows = Array.from(
    { length: 80 },
    (_, i) => `| R${String(i).padStart(2, "0")} | ${1000 + i} |`,
  );
  const table = ["| Region | Total |", "| --- | ---: |", ...rows].join("\n");
  const source = `Quarterly summary.\n\n${table}\n\nNext steps.`;
  const capture = (chunker: EmbeddedBlockChunker) => {
    const chunks: string[] = [];
    const metadata: BlockChunkMetadata[] = [];
    return {
      chunks,
      metadata,
      drain(force = false) {
        chunker.drain({
          force,
          emit(text, details) {
            chunks.push(text);
            if (details) {
              metadata.push(details);
            }
          },
        });
      },
    };
  };

  it.each([1, 17, source.length])(
    "renders every row when deltas contain %i characters",
    (delta) => {
      const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
      const chunks: string[] = [];
      const metadata: BlockChunkMetadata[] = [];
      const emit = (text: string, details?: BlockChunkMetadata) => {
        chunks.push(text);
        if (details) {
          metadata.push(details);
        }
      };
      for (let start = 0; start < source.length; start += delta) {
        chunker.append(source.slice(start, start + delta));
        chunker.drain({ force: false, emit });
      }
      chunker.drain({ force: true, emit });

      const rendered = chunks.map((chunk) => convertMarkdownTables(chunk, "code"));
      const bullets = chunks.map((chunk) => convertMarkdownTables(chunk, "bullets"));
      expect(bullets.join("\n")).not.toMatch(/^\| R\d+/m);
      expect(rendered.join("\n").match(/R\d{2}/g)).toEqual(
        rows.map((_, i) => `R${String(i).padStart(2, "0")}`),
      );
      expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
      expect(rendered.every((chunk) => chunk.length <= 2000)).toBe(true);
      expect(metadata.map((entry) => entry.sourceText).join("")).toBe(source);
      expect(metadata.map((entry) => entry.sourceStart)).toEqual([
        0,
        ...metadata.slice(0, -1).map((entry) => entry.sourceEnd),
      ]);
      expect(chunker.consumedLength).toBe(source.length);
      expect(chunker.bufferedText).toBe("");
    },
  );

  it("starts a new source without the previous table's header or pending rows", () => {
    const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
    const previous = capture(chunker);
    chunker.append(table);
    previous.drain();
    expect(previous.chunks.length).toBeGreaterThan(0);
    expect(chunker.hasBuffered()).toBe(true);

    chunker.reset();
    const next = capture(chunker);
    const fresh = "| Item | Count |\n| --- | --- |\n| apples | 42 |";
    chunker.append(fresh);
    next.drain(true);

    expect(next.chunks).toEqual([fresh]);
    expect(next.metadata.map((entry) => entry.sourceText).join("")).toBe(fresh);
    expect(next.metadata[0]?.sourceStart).toBe(0);
  });

  it("uses a corrected cumulative snapshot without replaying delivered table rows", () => {
    const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
    const output = capture(chunker);
    chunker.append(table);
    output.drain();
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(chunker.hasBuffered()).toBe(true);
    const corrected = table.replace("| R79 | 1079 |", "| R99 | 9999 |");

    chunker.replace(corrected);
    output.drain(true);

    const rendered = output.chunks.map((chunk) => convertMarkdownTables(chunk, "bullets"));
    expect(rendered.join("\n")).not.toMatch(/^\| R\d+/m);
    expect(rendered.join("\n").match(/R\d{2}/g)).toEqual([
      ...rows.slice(0, -1).map((_, i) => `R${String(i).padStart(2, "0")}`),
      "R99",
    ]);
    expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(corrected);
    expect(chunker.consumedLength).toBe(corrected.length);
    expect(chunker.hasBuffered()).toBe(false);
  });

  it("retains CRLF source bytes while rendering every continuation", () => {
    const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
    const output = capture(chunker);
    const windowsTable = table.replaceAll("\n", "\r\n");
    chunker.append(windowsTable);
    output.drain(true);

    const rendered = output.chunks.map((chunk) => convertMarkdownTables(chunk, "bullets"));
    expect(rendered.join("\n")).not.toMatch(/^\| R\d+/m);
    expect(rendered.join("\n").match(/R\d{2}/g)).toHaveLength(rows.length);
    expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(windowsTable);
    expect(output.chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
  });

  it.each(["\n", "\r\n"])(
    "retains the header when a streaming table ends at a buffered %j boundary",
    (newline) => {
      const initial = [
        "| A | B |",
        "| - | - |",
        ...Array.from(
          { length: 12 },
          (_, i) => `| ${String(i).padStart(2, "0")} | ${i < 6 ? 1 : 10} |`,
        ),
        "",
      ].join(newline);
      const tail = `| 12 | 10 |${newline}`;
      const chunker = new EmbeddedBlockChunker({ minChars: 50, maxChars: 100 });
      const output = capture(chunker);
      chunker.append(initial);
      output.drain();
      chunker.append(tail);
      output.drain(true);

      const rendered = output.chunks.map((chunk) => convertMarkdownTables(chunk, "bullets"));
      expect(rendered.join("\n")).not.toMatch(/^\| \d+/m);
      expect(rendered.join("\n").match(/\*\*\d{2}\*\*/g)).toEqual(
        Array.from({ length: 13 }, (_, i) => `**${String(i).padStart(2, "0")}**`),
      );
      expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(initial + tail);
      expect(output.chunks.every((chunk) => chunk.length <= 100)).toBe(true);
      expect(chunker.hasBuffered()).toBe(false);
    },
  );

  it("keeps table continuations renderable across a reconciled source boundary", () => {
    const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
    chunker.reset([table.indexOf("| R77 |")]);
    const output = capture(chunker);
    chunker.append(table);
    output.drain(true);

    const rendered = output.chunks.map((chunk) => convertMarkdownTables(chunk, "bullets"));
    expect(rendered.join("\n")).not.toMatch(/^\| R\d+/m);
    expect(rendered.join("\n").match(/R\d{2}/g)).toHaveLength(rows.length);
    expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(table);
    expect(chunker.consumedLength).toBe(table.length);
  });

  it("retains the header while later continuations wait for more streamed rows", () => {
    const longRows = Array.from({ length: 240 }, (_, i) => `| R${i} | ${1000 + i} |`);
    const longTable = ["| Region | Total |", "| --- | ---: |", ...longRows].join("\n");
    const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
    const output = capture(chunker);
    for (let start = 0; start < longTable.length; start += 17) {
      chunker.append(longTable.slice(start, start + 17));
      output.drain();
    }
    output.drain(true);

    const rendered = output.chunks.map((chunk) => convertMarkdownTables(chunk, "bullets"));
    expect(output.chunks.length).toBeGreaterThan(2);
    expect(rendered.join("\n")).not.toMatch(/^\| R\d+/m);
    expect(rendered.join("\n").match(/R\d+/g)).toEqual(longRows.map((_, i) => `R${i}`));
    expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(longTable);
    expect(output.chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
  });

  it("does not replay an over-cap header at a reconciled source boundary", () => {
    const oversized = `| ${"Header".repeat(20)} | Total |\n| --- | --- |\n| R00 | 1 |\n| R01 | 2 |\n| R02 | 3 |\n`;
    const chunker = new EmbeddedBlockChunker({ minChars: 50, maxChars: 100 });
    chunker.reset([oversized.indexOf("| R01 |")]);
    const output = capture(chunker);
    chunker.append(oversized);
    output.drain(true);

    expect(output.chunks.join("").match(/Header/g)).toHaveLength(20);
    expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(oversized);
    expect(output.chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunker.hasBuffered()).toBe(false);
  });

  it("preserves an over-cap row and finishes instead of repeatedly emitting headers", () => {
    const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
    const output = capture(chunker);
    const oversized = `| Region | Total |\n| --- | --- |\n| ${"x".repeat(2500)} | 42 |`;
    chunker.append(oversized);
    output.drain();
    output.drain(true);

    expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(oversized);
    expect(output.chunks.join("").match(/x/g)).toHaveLength(2500);
    expect(output.chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
    expect(chunker.consumedLength).toBe(oversized.length);
    expect(chunker.hasBuffered()).toBe(false);
    const count = output.chunks.length;
    output.drain(true);
    expect(output.chunks).toHaveLength(count);
  });

  it("keeps the existing hard-break fallback for container-dependent tables", () => {
    const nested = `- Outer\n  - Inner\n\n${table.replace(/^/gm, "    ")}`;
    const chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 });
    const output = capture(chunker);
    chunker.append(nested);
    output.drain(true);

    expect(output.chunks.join("\n").match(/Region/g)).toHaveLength(1);
    expect(output.chunks.join("\n").match(/R\d{2}/g)).toHaveLength(rows.length);
    expect(output.metadata.map((entry) => entry.sourceText).join("")).toBe(nested);
    expect(output.chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
  });
});
