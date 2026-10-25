import { expect, it } from "vitest";
import { convertMarkdownTables } from "../../packages/markdown-core/src/tables.js";
import { EmbeddedBlockChunker, type BlockChunkMetadata } from "./embedded-agent-block-chunker.js";

const rows = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => "| R" + String(i).padStart(2, "0") + " | " + (1000 + i) + " |",
  );
const table = ["| Region | Total |", "| --- | ---: |", ...rows(80)].join("\n");
const source = "Quarterly summary.\n\n" + table + "\n\nNext steps.";
const longTable = ["| Region | Total |", "| --- | ---: |", ...rows(240)].join("\n");
function capture(maxChars = 1200) {
  const chunker = new EmbeddedBlockChunker({ minChars: maxChars === 100 ? 50 : 800, maxChars });
  const chunks: string[] = [];
  const metadata: BlockChunkMetadata[] = [];
  const drain = (force = false) =>
    chunker.drain({
      force,
      emit: (text, details) => {
        chunks.push(text);
        if (details) {
          metadata.push(details);
        }
      },
    });
  return {
    chunker,
    chunks,
    metadata,
    drain,
    append(text: string, force = true) {
      chunker.append(text);
      drain(force);
    },
    assertSource(text: string) {
      expect(metadata.map((entry) => entry.sourceText).join("")).toBe(text);
      expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
    },
    bullets() {
      const rendered = chunks.map((chunk) => convertMarkdownTables(chunk, "bullets")).join("\n");
      expect(rendered).not.toMatch(/^\| R\d+/m);
      return rendered;
    },
  };
}

it.each([
  ["single-character", source, 1, [], true],
  ["single-delta", source, source.length, [], true],
  ["CRLF", table.replaceAll("\n", "\r\n"), Infinity, [], true],
  ["reconciled", table, Infinity, [table.indexOf("| R77 |")], true],
  ["later continuations", longTable, 17, [], true],
  ["nested fallback", "- Outer\n  - Inner\n\n" + table.replace(/^/gm, "    "), Infinity, [], false],
] satisfies Array<[string, string, number, number[], boolean]>)(
  "preserves rows and source bytes for %s tables",
  (_name, text, delta, boundaries, renderable) => {
    const output = capture();
    output.chunker.reset(boundaries);
    for (let start = 0; start < text.length; start += delta) {
      output.append(text.slice(start, start + delta), false);
    }
    output.drain(true);
    const rendered = renderable ? output.bullets() : output.chunks.join("\n");
    expect(rendered.match(/R\d+/g)).toEqual(text.match(/R\d+/g));
    output.assertSource(text);
    expect(output.chunker.consumedLength).toBe(text.length);
    expect(output.chunker.bufferedText).toBe("");
    expect(output.metadata.map((entry) => entry.sourceStart)).toEqual([
      0,
      ...output.metadata.slice(0, -1).map((entry) => entry.sourceEnd),
    ]);
    if (renderable) {
      expect(
        output.chunks
          .map((chunk) => convertMarkdownTables(chunk, "code"))
          .every((chunk) => chunk.length <= 2000),
      ).toBe(true);
    } else {
      expect(rendered.match(/Region/g)).toHaveLength(1);
    }
    if (text === longTable) {
      expect(output.chunks.length).toBeGreaterThan(2);
    }
  },
);
it("resets the header, pending rows and source position", () => {
  const output = capture();
  output.append(table, false);
  expect(output.chunks.length).toBeGreaterThan(0);
  expect(output.chunker.hasBuffered()).toBe(true);
  output.chunker.reset();
  output.chunks.length = output.metadata.length = 0;
  const fresh = "| Item | Count |\n| --- | --- |\n| apples | 42 |";
  output.append(fresh);
  expect(output.chunks).toEqual([fresh]);
  output.assertSource(fresh);
  expect(output.metadata[0]?.sourceStart).toBe(0);
});
it("applies a corrected cumulative snapshot without replaying delivered rows", () => {
  const output = capture();
  output.append(table, false);
  expect(output.chunks.length).toBeGreaterThan(0);
  expect(output.chunker.hasBuffered()).toBe(true);
  const corrected = table.replace("| R79 | 1079 |", "| R99 | 9999 |");
  output.chunker.replace(corrected);
  output.drain(true);
  expect(output.bullets().match(/R\d+/g)).toEqual(corrected.match(/R\d+/g));
  output.assertSource(corrected);
  expect(output.chunker.consumedLength).toBe(corrected.length);
  expect(output.chunker.hasBuffered()).toBe(false);
});
it.each(["\n", "\r\n"])("retains the header at a buffered %j boundary", (newline) => {
  const initial = [
    "| A | B |",
    "| - | - |",
    ...Array.from(
      { length: 12 },
      (_, i) => "| " + String(i).padStart(2, "0") + " | " + (i < 6 ? 1 : 10) + " |",
    ),
    "",
  ].join(newline);
  const tail = "| 12 | 10 |" + newline;
  const output = capture(100);
  output.append(initial, false);
  output.append(tail);
  const rendered = output.bullets();
  expect(rendered).not.toMatch(/^\| \d+/m);
  expect(rendered.match(/\*\*\d{2}\*\*/g)).toEqual(
    Array.from({ length: 13 }, (_, i) => "**" + String(i).padStart(2, "0") + "**"),
  );
  output.assertSource(initial + tail);
  expect(output.chunker.hasBuffered()).toBe(false);
});
it("does not replay an over-cap header at a reconciled boundary", () => {
  const text =
    "| " +
    "Header".repeat(20) +
    " | Total |\n| --- | --- |\n| R00 | 1 |\n| R01 | 2 |\n| R02 | 3 |\n";
  const output = capture(100);
  output.chunker.reset([text.indexOf("| R01 |")]);
  output.append(text);
  expect(output.chunks.join("").match(/Header/g)).toHaveLength(20);
  output.assertSource(text);
  expect(output.chunker.hasBuffered()).toBe(false);
});
it("splits an over-cap row and finishes without repeatedly emitting headers", () => {
  const text = "| Region | Total |\n| --- | --- |\n| " + "x".repeat(2500) + " | 42 |";
  const output = capture();
  output.append(text, false);
  output.drain(true);
  output.assertSource(text);
  expect(output.chunks.join("").match(/x/g)).toHaveLength(2500);
  expect(output.chunker.consumedLength).toBe(text.length);
  expect(output.chunker.hasBuffered()).toBe(false);
  const count = output.chunks.length;
  output.drain(true);
  expect(output.chunks).toHaveLength(count);
});
