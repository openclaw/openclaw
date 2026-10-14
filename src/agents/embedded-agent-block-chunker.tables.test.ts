import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";

function drainChunks(chunker: EmbeddedBlockChunker, force = false) {
  const chunks: string[] = [];
  chunker.drain({ force, emit: (chunk) => chunks.push(chunk) });
  return chunks;
}

function expectChunksWithinLength(chunks: string[], maxLength: number) {
  expect(
    chunks
      .map((chunk, index) => ({ index, length: chunk.length }))
      .filter((entry) => entry.length > maxLength),
  ).toStrictEqual([]);
}

describe("EmbeddedBlockChunker Markdown tables", () => {
  // Discord's native block-streaming defaults.
  const chunking = { minChars: 800, maxChars: 1200, breakPreference: "paragraph" } as const;
  const intro = "Here is the quarterly summary you asked for.";
  const outro = "Totals are rounded to the nearest unit.";
  const buildTable = (rowCount: number) =>
    [
      "| Region | Owner | Q1 | Q2 |",
      "| --- | --- | ---: | ---: |",
      ...Array.from(
        { length: rowCount },
        (_, i) => `| R${String(i + 1).padStart(2, "0")} | North | ${1100 + i} | ${2200 + i} |`,
      ),
    ].join("\n");
  const table = buildTable(28);
  const quotedTable = table
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const longIntro = "Background detail. ".repeat(20).trim();
  const capRows = buildTable(38);
  // Pad one header cell so the whole table is exactly maxChars long.
  const tableAtCap = capRows.replace(
    "Region",
    `Region${" ".repeat(chunking.maxChars - capRows.length)}`,
  );

  function streamChunks(text: string, delta: number) {
    const chunker = new EmbeddedBlockChunker(chunking);
    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += delta) {
      chunker.append(text.slice(index, index + delta));
      chunks.push(...drainChunks(chunker));
    }
    chunks.push(...drainChunks(chunker, true));
    return chunks;
  }

  it.each([
    {
      name: "after a short intro",
      text: `${intro}\n\n${table}\n\n${outro}`,
      expected: [`${intro}\n\n${table}`, outro],
    },
    {
      name: "inside a blockquote",
      text: `${intro}\n\n${quotedTable}\n\n${outro}`,
      expected: [`${intro}\n\n${quotedTable}`, outro],
    },
    {
      name: "by breaking before it when the intro leaves no room",
      text: `${longIntro}\n\n${table}\n\n${outro}`,
      expected: [longIntro, table, outro],
    },
    {
      name: "when it exactly fills maxChars",
      text: `${tableAtCap}\n\n${outro}`,
      expected: [tableAtCap, outro],
    },
    {
      name: "when it exactly fills maxChars and a heading follows directly",
      text: `${intro}\n\n${tableAtCap}\n# Next steps`,
      expected: [intro, tableAtCap, "# Next steps"],
      oneShot: true,
    },
  ])("keeps a streamed table that fits maxChars whole $name", ({ text, expected, oneShot }) => {
    for (const delta of oneShot ? [1, 17, 43, text.length] : [1, 17, 43]) {
      expect(streamChunks(text, delta)).toEqual(expected);
    }
  });

  it.each([
    { name: "with many rows", text: `${intro}\n\n${buildTable(60)}\n\n${outro}` },
    { name: "with trailing spaces past the cap", text: `${tableAtCap}  \n\n${outro}` },
  ])("still splits a table larger than maxChars at row boundaries $name", ({ text }) => {
    for (const delta of [1, 17, text.length]) {
      const chunks = streamChunks(text, delta);
      expectChunksWithinLength(chunks, chunking.maxChars);
      expect(chunks.flatMap((chunk) => chunk.split("\n")).filter(Boolean)).toEqual(
        text.split("\n").filter(Boolean),
      );
    }
  });

  it("streams pipe-bearing prose at the same boundaries as plain prose", () => {
    const text = Array.from({ length: 60 }, (_, i) => `step ${i}: alpha | beta | gamma`).join("\n");
    for (const delta of [1, 17]) {
      const lengths = (source: string) => streamChunks(source, delta).map((chunk) => chunk.length);
      expect(lengths(text)).toEqual(lengths(text.replaceAll("|", "/")));
    }
  });

  it("emits a table that exactly fills maxChars once the next line starts", () => {
    const chunker = new EmbeddedBlockChunker(chunking);
    const chunks: string[] = [];
    for (const character of `${tableAtCap}\n${" ".repeat(20)}`) {
      chunker.append(character);
      chunks.push(...drainChunks(chunker));
    }
    expect(chunks).toEqual([tableAtCap]);
  });
});
