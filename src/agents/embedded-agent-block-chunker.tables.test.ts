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
  const capture = (chunker = new EmbeddedBlockChunker({ minChars: 800, maxChars: 1200 })) => {
    const chunks: string[] = [];
    const metadata: BlockChunkMetadata[] = [];
    return {
      chunks,
      metadata,
      chunker,
      append(text: string, force = true) {
        chunker.append(text);
        this.drain(force);
      },
      expectSource(expectedSource: string, maxChars = 1200) {
        expect(metadata.map((entry) => entry.sourceText).join("")).toBe(expectedSource);
        expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
      },
      bullets() {
        const rendered = chunks.map((chunk) => convertMarkdownTables(chunk, "bullets")).join("\n");
        expect(rendered).not.toMatch(/^\| R\d+/m);
        return rendered;
      },
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
      const output = capture();
      const { chunker, chunks, metadata } = output;
      for (let start = 0; start < source.length; start += delta) {
        output.append(source.slice(start, start + delta), false);
      }
      output.drain(true);

      const rendered = chunks.map((chunk) => convertMarkdownTables(chunk, "code"));
      output.bullets();
      expect(rendered.join("\n").match(/R\d{2}/g)).toEqual(
        rows.map((_, i) => `R${String(i).padStart(2, "0")}`),
      );
      expect(rendered.every((chunk) => chunk.length <= 2000)).toBe(true);
      output.expectSource(source);
      expect(metadata.map((entry) => entry.sourceStart)).toEqual([
        0,
        ...metadata.slice(0, -1).map((entry) => entry.sourceEnd),
      ]);
      expect(chunker.consumedLength).toBe(source.length);
      expect(chunker.bufferedText).toBe("");
    },
  );

  it("starts a new source without the previous table's header or pending rows", () => {
    const previous = capture();
    const { chunker } = previous;
    previous.append(table, false);
    expect(previous.chunks.length).toBeGreaterThan(0);
    expect(chunker.hasBuffered()).toBe(true);

    chunker.reset();
    const next = capture(chunker);
    const fresh = "| Item | Count |\n| --- | --- |\n| apples | 42 |";
    next.append(fresh);

    expect(next.chunks).toEqual([fresh]);
    next.expectSource(fresh);
    expect(next.metadata[0]?.sourceStart).toBe(0);
  });

  it("uses a corrected cumulative snapshot without replaying delivered table rows", () => {
    const output = capture();
    const { chunker } = output;
    output.append(table, false);
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(chunker.hasBuffered()).toBe(true);
    const corrected = table.replace("| R79 | 1079 |", "| R99 | 9999 |");

    chunker.replace(corrected);
    output.drain(true);

    expect(output.bullets().match(/R\d{2}/g)).toEqual([
      ...rows.slice(0, -1).map((_, i) => `R${String(i).padStart(2, "0")}`),
      "R99",
    ]);
    output.expectSource(corrected);
    expect(chunker.consumedLength).toBe(corrected.length);
    expect(chunker.hasBuffered()).toBe(false);
  });

  it("retains CRLF source bytes while rendering every continuation", () => {
    const output = capture();
    const windowsTable = table.replaceAll("\n", "\r\n");
    output.append(windowsTable);

    expect(output.bullets().match(/R\d{2}/g)).toHaveLength(rows.length);
    output.expectSource(windowsTable);
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
      output.expectSource(initial + tail, 100);
      expect(chunker.hasBuffered()).toBe(false);
    },
  );

  it("keeps table continuations renderable across a reconciled source boundary", () => {
    const output = capture();
    const { chunker } = output;
    chunker.reset([table.indexOf("| R77 |")]);
    output.append(table);

    expect(output.bullets().match(/R\d{2}/g)).toHaveLength(rows.length);
    output.expectSource(table);
    expect(chunker.consumedLength).toBe(table.length);
  });

  it("retains the header while later continuations wait for more streamed rows", () => {
    const longRows = Array.from({ length: 240 }, (_, i) => `| R${i} | ${1000 + i} |`);
    const longTable = ["| Region | Total |", "| --- | ---: |", ...longRows].join("\n");
    const output = capture();
    for (let start = 0; start < longTable.length; start += 17) {
      output.append(longTable.slice(start, start + 17), false);
    }
    output.drain(true);

    expect(output.chunks.length).toBeGreaterThan(2);
    expect(output.bullets().match(/R\d+/g)).toEqual(longRows.map((_, i) => `R${i}`));
    output.expectSource(longTable);
  });

  it("does not replay an over-cap header at a reconciled source boundary", () => {
    const oversized = `| ${"Header".repeat(20)} | Total |\n| --- | --- |\n| R00 | 1 |\n| R01 | 2 |\n| R02 | 3 |\n`;
    const chunker = new EmbeddedBlockChunker({ minChars: 50, maxChars: 100 });
    chunker.reset([oversized.indexOf("| R01 |")]);
    const output = capture(chunker);
    output.append(oversized);

    expect(output.chunks.join("").match(/Header/g)).toHaveLength(20);
    output.expectSource(oversized, 100);
    expect(chunker.hasBuffered()).toBe(false);
  });

  it("preserves an over-cap row and finishes instead of repeatedly emitting headers", () => {
    const output = capture();
    const { chunker } = output;
    const oversized = `| Region | Total |\n| --- | --- |\n| ${"x".repeat(2500)} | 42 |`;
    output.append(oversized, false);
    output.drain(true);

    output.expectSource(oversized);
    expect(output.chunks.join("").match(/x/g)).toHaveLength(2500);
    expect(chunker.consumedLength).toBe(oversized.length);
    expect(chunker.hasBuffered()).toBe(false);
    const count = output.chunks.length;
    output.drain(true);
    expect(output.chunks).toHaveLength(count);
  });

  it("keeps the existing hard-break fallback for container-dependent tables", () => {
    const nested = `- Outer\n  - Inner\n\n${table.replace(/^/gm, "    ")}`;
    const output = capture();
    output.append(nested);

    expect(output.chunks.join("\n").match(/Region/g)).toHaveLength(1);
    expect(output.chunks.join("\n").match(/R\d{2}/g)).toHaveLength(rows.length);
    output.expectSource(nested);
  });
});
