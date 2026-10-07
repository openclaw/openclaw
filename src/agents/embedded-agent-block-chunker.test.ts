// Covers streaming chunk boundaries for embedded-agent text blocks.
import { describe, expect, it, vi } from "vitest";
import * as fences from "../../packages/markdown-core/src/fences.js";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

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

describe("EmbeddedBlockChunker", () => {
  it.each([
    { breakPreference: "paragraph", suffix: "ready\n\nTail", expected: "First line is ready" },
    { breakPreference: "newline", suffix: "ready\nTail", expected: "First line is ready" },
    { breakPreference: "sentence", suffix: "ready. Tail", expected: "First line is ready." },
  ] as const)(
    "waits for a $breakPreference boundary before falling back to whitespace",
    ({ breakPreference, suffix, expected }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 8,
        maxChars: 30,
        breakPreference,
        flushOnParagraph: false,
      });

      for (const character of "First line is ") {
        chunker.append(character);
        expect(drainChunks(chunker)).toEqual([]);
      }
      chunker.append(suffix);

      expect(drainChunks(chunker)).toEqual([expected]);
      expect(drainChunks(chunker, true)).toEqual(["Tail"]);
      expect(chunker.bufferedText).toBe("");
    },
  );

  it.each([
    {
      breakPreference: "paragraph",
      text: "Aaaa\n\nBbbb\n\nCccc",
      normal: [{ chunk: "Aaaa\n\nBbbb", sourceText: "Aaaa\n\nBbbb\n\n" }],
      forced: [
        { chunk: "Aaaa", sourceText: "Aaaa\n\n" },
        { chunk: "Bbbb", sourceText: "Bbbb\n\n" },
        { chunk: "Cccc", sourceText: "Cccc" },
      ],
      tail: "Cccc",
    },
    {
      breakPreference: "newline",
      text: "Aaaa\nBbbb\nCccc",
      normal: [{ chunk: "Aaaa\nBbbb", sourceText: "Aaaa\nBbbb\n" }],
      forced: [
        { chunk: "Aaaa", sourceText: "Aaaa\n" },
        { chunk: "Bbbb", sourceText: "Bbbb\n" },
        { chunk: "Cccc", sourceText: "Cccc" },
      ],
      tail: "Cccc",
    },
    {
      breakPreference: "sentence",
      text: "Aaaa. Bbbb. Tail",
      normal: [{ chunk: "Aaaa. Bbbb.", sourceText: "Aaaa. Bbbb. " }],
      forced: [
        { chunk: "Aaaa. Bbbb.", sourceText: "Aaaa. Bbbb. " },
        { chunk: "Tail", sourceText: "Tail" },
      ],
      tail: "Tail",
    },
  ] as const)(
    "preserves $breakPreference selection and source cursors across a forced tail",
    ({ breakPreference, text, normal, forced, tail }) => {
      for (const force of [false, true]) {
        const prefix = force ? `${"x".repeat(20)}\n` : "";
        const source = prefix + text;
        const chunker = new EmbeddedBlockChunker({ minChars: 3, maxChars: 20, breakPreference });
        const emitted: Array<{ chunk: string; sourceText: string | undefined }> = [];
        const emit = (chunk: string, options?: { sourceText: string }) =>
          emitted.push({ chunk, sourceText: options?.sourceText });
        chunker.append(source);
        chunker.drain({ force, emit });
        expect(emitted).toEqual(
          force ? [{ chunk: "x".repeat(20), sourceText: prefix }, ...forced] : normal,
        );
        expect(chunker.bufferedText).toBe(force ? "" : tail);
        expect(chunker.hasBuffered()).toBe(!force);
        expect(chunker.consumedLength).toBe(source.length - (force ? 0 : tail.length));
        expect(chunker.sourceLength).toBe(source.length);
        emitted.length = 0;
        chunker.drain({ force: true, emit });
        expect(emitted).toEqual(force ? [] : [{ chunk: tail, sourceText: tail }]);
        expect(chunker.bufferedText).toBe("");
        expect(chunker.hasBuffered()).toBe(false);
        expect(chunker.consumedLength).toBe(source.length);
        expect(chunker.sourceLength).toBe(source.length);
        expect(drainChunks(chunker, true)).toEqual([]);
      }
    },
  );

  it.each([
    {
      name: "ordinary drain",
      deltas: ["    A_153587\n\n    B_153587"],
      force: false,
      code: "A_153587\n\nB_153587\n",
    },
    {
      name: "incomplete blank-line delta",
      deltas: ["    A_153587\n\n", "    B_153587"],
      force: false,
      code: "A_153587\n\nB_153587\n",
    },
    {
      name: "fitting tail in an oversized forced drain",
      deltas: ["Intro text here.\n\n    line one\n    line two\n\n    line four\n    line five"],
      force: true,
      code: "line one\nline two\n\nline four\nline five\n",
    },
    {
      name: "tab indentation with literal excess spaces",
      deltas: ["\t  A_153587\n\n\tB_153587"],
      force: false,
      code: "  A_153587\n\nB_153587\n",
    },
    {
      name: "literal fence markers",
      deltas: ["    ``` marker\n\n    tail"],
      force: false,
      code: "``` marker\n\ntail\n",
    },
  ])("preserves rendered indented code through $name", ({ deltas, force, code }) => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 60,
      breakPreference: "paragraph",
    });
    const chunks: string[] = [];
    for (const delta of deltas) {
      chunker.append(delta);
      if (!force) {
        chunks.push(...drainChunks(chunker));
      }
    }
    chunks.push(...drainChunks(chunker, true));

    const renderedCode = chunks.flatMap((chunk) => {
      const ir = markdownToIR(chunk);
      return ir.styles
        .filter((span) => span.style === "code_block")
        .map((span) => ir.text.slice(span.start, span.end));
    });
    expect(renderedCode).toEqual([code]);
    expectChunksWithinLength(chunks, 60);
    expect(chunker.consumedLength).toBe(deltas.join("").length);
  });

  it.each([
    { force: false, body: `${"A".repeat(56)} TAIL_153587` },
    { force: true, body: `${"A".repeat(56)} TAIL_153587` },
    { force: false, body: `${"A".repeat(51)}😀 TAIL_153587` },
  ])(
    "retains literal space and code ownership across an oversized indented line (force: $force, body: $body)",
    ({ force, body }) => {
      const source = `    ${body}`;
      const chunker = new EmbeddedBlockChunker({ minChars: 10, maxChars: 60 });
      const chunks: string[] = [];
      const sources: string[] = [];
      const emit = (chunk: string, options?: { sourceText: string }) => {
        chunks.push(chunk);
        sources.push(options?.sourceText ?? "");
      };
      chunker.append(source);
      chunker.drain({ force, emit });
      chunker.drain({ force: true, emit });

      const code = chunks.map((chunk) => {
        const ir = markdownToIR(chunk);
        const span = ir.styles.find((entry) => entry.style === "code_block");
        expect(span).toBeDefined();
        if (!span) {
          throw new Error("indented continuation rendered as prose");
        }
        expect(ir.text.slice(0, span.start).trim()).toBe("");
        expect(ir.text.slice(span.end).trim()).toBe("");
        // This fixture has no authored line ending; IR adds one per code block.
        return ir.text.slice(span.start, span.end).replace(/\n$/, "");
      });
      expect(code.join("")).toBe(body);
      expect(sources.join("")).toBe(source);
      expect(chunker.consumedLength).toBe(source.length);
      expectChunksWithinLength(chunks, 60);
    },
  );

  it.each([false, true])(
    "completes Unicode code followed by a long whitespace run (force: %s)",
    async (force) => {
      // A synchronous stalled drain needs an external deadline, not Vitest's in-process timer.
      const chunkerUrl = resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.blockChunker);
      const result = await runNodeScript(
        (workerArgv) => [
          ...workerArgv(chunkerUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          `
            import assert from "node:assert/strict";
            import { EmbeddedBlockChunker } from ${JSON.stringify(chunkerUrl.href)};
            import { markdownToIR } from ${JSON.stringify(resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.markdownIr).href)};
            const body = "A".repeat(52) + "\\u{1f600}" + " ".repeat(60) + "B";
            const source = "    " + body;
            const chunker = new EmbeddedBlockChunker({ minChars: 10, maxChars: 60 });
            const chunks = [];
            const sources = [];
            const emit = (text, metadata) => {
              chunks.push(text);
              sources.push(metadata.sourceText);
            };
            chunker.append(source);
            console.log("drain-started");
            chunker.drain({ force: ${force}, emit });
            chunker.drain({ force: true, emit });
            assert.equal(chunks.map((chunk) => {
              assert.ok(chunk.length <= 60 && chunk.isWellFormed());
              const ir = markdownToIR(chunk);
              const span = ir.styles.find((entry) => entry.style === "code_block");
              assert.ok(span, "continuation lost code formatting");
              assert.equal(span.start, 0);
              assert.equal(span.end, ir.text.length);
              return ir.text.slice(span.start, span.end).replace(/\\n$/, "");
            }).join(""), body);
            assert.equal(sources.join(""), source);
            assert.equal(chunker.consumedLength, source.length);
            assert.equal(chunker.hasBuffered(), false);
            console.log("drain-completed");
          `,
        ],
        process.env,
        5_000,
        { requireProcessTreeExit: true },
      );
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it.each([">     literal", "- item\n\n      literal"])(
    "leaves nested-container Markdown unchanged: %s",
    (source) => {
      const chunker = new EmbeddedBlockChunker({ minChars: 50, maxChars: 60 });
      chunker.append(source);
      expect(drainChunks(chunker)).toEqual([]);
      expect(drainChunks(chunker, true)).toEqual([source]);
    },
  );

  it("reconciles indented source after a cap without replaying delivered code", () => {
    const chunker = new EmbeddedBlockChunker({ minChars: 10, maxChars: 60 });
    chunker.append(`    ${"A".repeat(56)}old`);
    const first = drainChunks(chunker);
    expect(chunker.consumedLength).toBe(56);
    const snapshot = `    ${"A".repeat(52)}NEW`;
    expect(chunker.replace(snapshot)).toBe(true);
    const chunks = [...first, ...drainChunks(chunker, true)];
    const code = chunks.map((chunk) => {
      const ir = markdownToIR(chunk);
      return ir.styles
        .filter((span) => span.style === "code_block")
        .map((span) => ir.text.slice(span.start, span.end).replace(/\n$/, ""))
        .join("");
    });
    expect(code.join("")).toBe(`${"A".repeat(52)}NEW`);
    expect(chunker.consumedLength).toBe(snapshot.length);
    expect(chunker.sourceLength).toBe(snapshot.length);
    expect(drainChunks(chunker, true)).toEqual([]);
  });

  type FenceDrainScenario = {
    name: string;
    steps: Array<{ append?: string; force?: boolean; expected: string[]; buffered?: string }>;
  };
  it.each([
    {
      name: "unfinished fence continuation",
      steps: [
        { append: "```ts\nabcdefghijklm", expected: [] },
        { append: "n", expected: ["```ts\nabcdefghij\n```"], buffered: "```ts\nklmn" },
        { append: "op\n```", expected: [] },
        { force: true, expected: ["```ts\nklmnop\n```"], buffered: "" },
      ],
    },
    { name: "punctuation below cap", steps: [{ append: "```ts\nabcdefg.", expected: [] }] },
    {
      name: "punctuation at cap",
      steps: [{ append: "```ts\nabcdefghijklm.", expected: ["```ts\nabcdefghij\n```"] }],
    },
    {
      name: "genuine closing fence",
      steps: [
        { append: "```ts\nabcdefghij\n", expected: [] },
        { append: "```", expected: ["```ts\nabcdefghij\n```"] },
        { force: true, expected: [] },
        { append: "Tail", force: true, expected: ["Tail"] },
      ],
    },
  ] satisfies FenceDrainScenario[])(
    "keeps streamed fence boundaries intact: $name",
    ({ steps }: FenceDrainScenario) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 8,
        maxChars: 20,
        breakPreference: "paragraph",
      });
      for (const step of steps) {
        if (step.append !== undefined) {
          chunker.append(step.append);
        }
        expect(drainChunks(chunker, "force" in step && step.force)).toEqual(step.expected);
        if (step.buffered !== undefined) {
          expect(chunker.bufferedText).toBe(step.buffered);
        }
      }
    },
  );

  it.each([false, true])(
    "reports original source across synthetic wrappers with a preserved break: %s",
    (preserveBreak) => {
      const chunker = new EmbeddedBlockChunker({ minChars: 1, maxChars: 20 });
      const delivered: Array<{ text: string; sourceText?: string }> = [];
      const fenced = "```txt\nabcdefghijklmnopqr\n```\n\n";
      if (preserveBreak) {
        chunker.reset([fenced.length]);
      }
      chunker.append(`${fenced}Tail`);
      chunker.drain({
        force: true,
        emit: (text, options) => delivered.push({ text, sourceText: options?.sourceText }),
      });

      expect(delivered).toEqual([
        { text: "```txt\nabcdefghi\n```", sourceText: "```txt\nabcdefghi" },
        { text: "```txt\njklmnopqr\n```", sourceText: "jklmnopqr\n```\n\n" },
        { text: "Tail", sourceText: "Tail" },
      ]);
    },
  );

  it("preserves code and source coverage across shortened fence metadata and indented code", () => {
    const body = `${"A".repeat(56)} TAIL`;
    const source = `\`\`\`${"language".repeat(20)}\nreal\n\`\`\`\n\n    ${body}`;
    const chunker = new EmbeddedBlockChunker({ minChars: 1, maxChars: 60 });
    const chunks: string[] = [];
    const sources: string[] = [];
    chunker.append(source);
    chunker.drain({
      force: true,
      emit: (text, options) => {
        chunks.push(text);
        sources.push(options?.sourceText ?? "");
      },
    });
    const code = chunks.flatMap((text) => {
      const ir = markdownToIR(text);
      return ir.styles
        .filter((span) => span.style === "code_block")
        .map((span) => ir.text.slice(span.start, span.end));
    });
    expect(code[0]).toBe("real\n");
    // This indented body has no authored newline; each rendered fragment adds one.
    expect(
      code
        .slice(1)
        .map((text) => text.replace(/\n$/u, ""))
        .join(""),
    ).toBe(body);
    expect(sources.join("")).toBe(source);
    expect(chunker.consumedLength).toBe(source.length);
    expectChunksWithinLength(chunks, 60);
  });

  it.each([
    { name: "below the cap", suffix: "Unchanged paragraph follows.\n", ready: false },
    { name: "at the cap", suffix: "Unchanged prose remains for this case. ", ready: true },
  ])(
    "drains a preserved short prefix $name and on force without merging its suffix",
    ({ suffix, ready }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 12,
        maxChars: 50,
        breakPreference: "newline",
      });
      const prefix = "Corrected. ";
      chunker.reset([prefix.length]);
      chunker.append(prefix + suffix);

      expect(drainChunks(chunker)).toEqual(ready ? [prefix] : []);
      expect(chunker.bufferedText).toBe(ready ? suffix : prefix + suffix);
      expect(drainChunks(chunker, true)).toEqual(ready ? [suffix] : [prefix, suffix]);
      expect(chunker.bufferedText).toBe("");
    },
  );

  it("replaces a pending preserved boundary before introducing a code fence", () => {
    const chunker = new EmbeddedBlockChunker({ minChars: 1, maxChars: 50 });
    const prefix = "Corrected. ";
    chunker.reset([prefix.length]);
    chunker.append(`${prefix}Unchanged prose follows.`);
    const replacement = "```txt\nA revised fenced answer.\n```";

    chunker.replace(replacement);

    expect(drainChunks(chunker, true)).toEqual([replacement]);
    expect(chunker.bufferedText).toBe("");
  });

  it.each([
    { tail: "Tail", changed: false, expected: ["Tail"] },
    { tail: "", changed: true, expected: [] },
    { tail: "Fixed tail", changed: true, expected: ["Fixed tail"] },
  ])(
    "reconciles pending '$tail' without replaying drained source",
    ({ tail, changed, expected }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars: 16,
        breakPreference: "sentence",
      });
      for (const sentence of ["Hello world.", "Next sentence."]) {
        chunker.append(`${sentence} `);
        expect(drainChunks(chunker)).toEqual([sentence]);
      }
      chunker.append("Tail");
      expect(chunker.consumedLength).toBe("Hello world. Next sentence. ".length);
      const snapshot = `Hello world. Next sentence.${tail ? ` ${tail}` : ""}`;

      expect(chunker.replace(snapshot)).toBe(changed);
      expect(chunker.sourceLength).toBe(snapshot.length);
      expect(drainChunks(chunker, true)).toEqual(expected);
      expect(chunker.consumedLength).toBe(snapshot.length);
      expect(chunker.replace(snapshot)).toBe(false);
      expect(drainChunks(chunker, true)).toEqual([]);
    },
  );

  it("buffers without chunking and replaces a native source suffix before or after a drain", () => {
    const chunker = new EmbeddedBlockChunker();
    chunker.append("Earlier ");
    const sourceOffset = chunker.sourceLength;
    chunker.append("Draft");
    expect(drainChunks(chunker)).toEqual([]);
    expect(chunker.replace("Fixed", sourceOffset)).toBe(true);
    expect(drainChunks(chunker, true)).toEqual(["Earlier Fixed"]);
    expect(chunker.consumedLength).toBe("Earlier Fixed".length);

    const nextOffset = chunker.sourceLength;
    chunker.append("Draft");
    expect(chunker.replace("Later", nextOffset)).toBe(true);
    expect(drainChunks(chunker, true)).toEqual(["Later"]);
    chunker.reset();
    expect(chunker.sourceLength).toBe(0);
    expect(chunker.consumedLength).toBe(0);
    chunker.append(" \n");
    expect(drainChunks(chunker, true)).toEqual([" \n"]);
  });

  it.each([
    {
      name: "regular",
      header: "```txt\n",
      renderedHeader: "```txt\n",
      body: "x".repeat(9),
      tail: "xxx😀tail",
      maxChars: 20,
      replacement: "NEW",
    },
    {
      name: "long-language",
      header: "```very-long-language-name\n",
      renderedHeader: "```\n",
      body: "q".repeat(22),
      tail: "qqqq\nold\n```",
      maxChars: 30,
      replacement: "",
    },
  ])(
    "reconciles $name fenced source with '$replacement' pending code",
    ({ header, renderedHeader, body, tail, maxChars, replacement }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars,
        breakPreference: "paragraph",
      });
      chunker.append(`${header}${body}${tail}`);
      expect(drainChunks(chunker)).toEqual([`${renderedHeader}${body}\n\`\`\``]);
      expect(chunker.consumedLength).toBe(header.length + body.length);

      const snapshot = `${header}${body}${replacement}\n\`\`\``;
      expect(chunker.replace(snapshot)).toBe(true);
      expect(chunker.sourceLength).toBe(snapshot.length);
      expect(chunker.bufferedText).toBe(`${renderedHeader}${replacement}\n\`\`\``);
      expect(drainChunks(chunker, true)).toEqual(
        replacement ? [`${renderedHeader}${replacement}\n\`\`\``] : [],
      );
      expect(chunker.consumedLength).toBe(snapshot.length);
    },
  );

  it("counts the source closing fence and skipped paragraph separator before replacing prose", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 30,
      breakPreference: "paragraph",
    });
    const prefix = `\`\`\`txt\n${"q".repeat(32)}\n\`\`\`\n\n`;
    chunker.append(`${prefix}Tail`);
    expect(drainChunks(chunker)).toEqual([
      `\`\`\`txt\n${"q".repeat(19)}\n\`\`\``,
      `\`\`\`txt\n${"q".repeat(13)}\n\`\`\``,
    ]);
    expect(chunker.consumedLength).toBe(prefix.length);
    expect(chunker.replace(`${prefix}Fixed`)).toBe(true);
    expect(drainChunks(chunker, true)).toEqual(["Fixed"]);
  });

  it.each([
    {
      name: "closed fence before prose",
      minChars: 1,
      maxChars: 40,
      flushOnParagraph: false,
      flushTail: false,
      source: "Intro\n```js\nconsole.log('x')\n```\n\nAfter first line\nAfter second line",
      expected: ["Intro\n```js\nconsole.log('x')\n```"],
      tail: "After first line\nAfter second line",
    },
    {
      name: "minimum paragraph length",
      minChars: 30,
      maxChars: 200,
      flushOnParagraph: true,
      flushTail: false,
      source: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      expected: ["First paragraph.\n\nSecond paragraph."],
      tail: "Third paragraph.",
    },
    {
      name: "forced short tail",
      minChars: 100,
      maxChars: 200,
      flushOnParagraph: true,
      flushTail: true,
      source: "First paragraph.\n \nSecond paragraph.",
      expected: [],
      tail: "First paragraph.\n \nSecond paragraph.",
    },
    {
      name: "capped paragraph",
      minChars: 1,
      maxChars: 10,
      flushOnParagraph: true,
      flushTail: false,
      source: "abcdefghijk\n\nRest",
      expected: ["abcdefghij", "k"],
      tail: "Rest",
    },
    {
      name: "blank lines inside a fence",
      minChars: 10,
      maxChars: 200,
      flushOnParagraph: true,
      flushTail: false,
      source: "Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter fence",
      expected: ["Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```"],
      tail: "After fence",
    },
  ])(
    "respects paragraph boundaries and size limits: $name",
    ({ minChars, maxChars, flushOnParagraph, flushTail, source, expected, tail }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars,
        maxChars,
        breakPreference: "paragraph",
        flushOnParagraph,
      });
      chunker.append(source);
      const chunks = drainChunks(chunker);
      expect(chunks).toEqual(expected);
      expectChunksWithinLength(chunks, maxChars);
      expect(chunker.bufferedText).toBe(tail);
      if (flushTail) {
        expect(drainChunks(chunker, true)).toEqual([tail]);
        expect(chunker.bufferedText).toBe("");
      }
    },
  );

  it("keeps forced maxChars chunks valid at UTF-16 boundaries", () => {
    const plainChunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 20,
      breakPreference: "paragraph",
    });
    plainChunker.append(`${"x".repeat(19)}😀tail`);

    expect(drainChunks(plainChunker)).toEqual(["x".repeat(19)]);
    expect(plainChunker.bufferedText).toBe("😀tail");

    const tinyChunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 1,
      breakPreference: "paragraph",
    });
    tinyChunker.append("😀tail");

    expect(drainChunks(tinyChunker)).toEqual(["😀", "t", "a", "i", "l"]);
    expect(tinyChunker.bufferedText).toBe("");

    const fencedChunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 20,
      breakPreference: "paragraph",
    });
    fencedChunker.append(`\`\`\`txt\n${"x".repeat(12)}😀tail`);

    expect(drainChunks(fencedChunker)).toEqual([`\`\`\`txt\n${"x".repeat(9)}\n\`\`\``]);
    expect(fencedChunker.bufferedText).toBe("```txt\nxxx😀tail");
  });

  it.each(["open", "closed"])(
    "bounds paragraph candidate scans while streaming a long %s fence",
    (kind) => {
      const maxChars = 1_200;
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars,
        breakPreference: "newline",
        flushOnParagraph: true,
      });
      const code = "code\n\n".repeat(600);
      const closing = "```\n\nAfter";
      const initial = `\`\`\`txt\n${code}${kind === "closed" ? closing : ""}`;
      const completed = `\`\`\`txt\n${code}${closing}`;
      const chunks: string[] = [];
      const sources: string[] = [];
      const emit = (chunk: string, options?: { sourceText: string }) => {
        chunks.push(chunk);
        sources.push(options?.sourceText ?? "");
      };
      chunker.append(initial);
      let candidates = 0;
      const scanSpy = vi.spyOn(fences, "scanFenceSpans");
      // Capture before spying; every invocation explicitly supplies the original RegExp receiver.
      // oxlint-disable-next-line typescript/unbound-method
      const nativeExec = RegExp.prototype.exec;
      const paragraphPattern = /\n[\t ]*\n+/g;
      const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
        this: RegExp,
        text: string,
      ) {
        const result = nativeExec.call(this, text);
        if (result && this.source === paragraphPattern.source && this.flags === "g") {
          candidates++;
        }
        return result;
      });
      try {
        chunker.drain({ force: false, emit });
        expect(scanSpy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        scanSpy.mockRestore();
      }
      const streamedCount = chunks.length;
      expect(streamedCount).toBeGreaterThan(1);
      expect(chunker.sourceLength).toBe(initial.length);
      if (kind === "open") {
        chunker.append(closing);
      }
      chunker.drain({ force: true, emit });

      expect(sources.join("")).toBe(completed);
      expect(chunker.consumedLength).toBe(completed.length);
      expect(chunker.sourceLength).toBe(completed.length);
      expect(chunker.bufferedText).toBe("");
      expectChunksWithinLength(chunks, maxChars);
      for (const chunk of chunks.filter((text) => text.startsWith("```"))) {
        expect(chunk.startsWith("```txt\n")).toBe(true);
        expect(chunk.trimEnd().endsWith("```")).toBe(true);
      }
      const rendered = chunks
        .flatMap((chunk) => chunk.split("\n").filter((line) => !line.startsWith("```")))
        .join("")
        .replace(/\s/g, "");
      expect(rendered).toBe(`${"code".repeat(600)}After`);
      expect(candidates).toBeLessThanOrEqual(3 * (streamedCount + 1));
    },
  );

  it.each([
    { marker: "```", finalLine: "XXXXXXXX", force: true },
    { marker: "~~~", finalLine: "XXXXXXXX", force: true },
    { marker: "  ```", finalLine: "XXXXXXXX", force: true },
    { marker: "````", finalLine: "XXXXXXXX", force: true },
    { marker: "```", finalLine: "😀😀😀😀", force: true },
    { marker: "```", finalLine: "``` XXXXXXXX", force: true },
    { marker: "```", finalLine: "~~~ XXXXXXXX", force: true },
    { marker: "```", finalLine: "    ``` XXXXXXXX", force: true },
    { marker: "```", finalLine: "XXXXXXXX", force: false },
    { marker: "~~~", finalLine: "XXXXXXXX", force: false },
  ])(
    "preserves the final content line in an unfinished $marker fence (force: $force)",
    ({ marker, finalLine, force }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 20,
        breakPreference: "paragraph",
      });
      chunker.append(`${marker}txt\n12345678\n${finalLine}`);

      const chunks = drainChunks(chunker, force);
      if (!force) {
        chunks.push(...drainChunks(chunker, true));
      }

      expectChunksWithinLength(chunks, 20);
      const contentCodePoint = finalLine.includes("😀") ? "😀" : "X";
      expect(
        Array.from(chunks.join("")).filter((value) => value === contentCodePoint),
      ).toHaveLength(Array.from(finalLine).filter((value) => value === contentCodePoint).length);
      expect(chunker.bufferedText).toBe("");
    },
  );

  it.each([
    { marker: "```", closingMarker: "`````" },
    { marker: "```", closingMarker: "   ``` \t" },
    { marker: "~~~", closingMarker: " ~~~~\t" },
    { marker: "  ```", closingMarker: "```" },
    { marker: "```", closingMarker: "```\r" },
  ])("recognizes valid $marker closing-fence variants", ({ marker, closingMarker }) => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 20,
      breakPreference: "paragraph",
    });
    chunker.append(`${marker}txt\n${"q".repeat(32)}\n${closingMarker}`);

    const chunks = drainChunks(chunker, true);

    expectChunksWithinLength(chunks, 20);
    expect(chunks.join("").match(/q/g)).toHaveLength(32);
    expect(chunks.every((chunk) => chunk.includes("q"))).toBe(true);
    expect(chunker.bufferedText).toBe("");
  });

  it.each([
    {
      name: "closed fence clamp",
      minChars: 10,
      maxChars: 30,
      marker: "```",
      language: "txt",
      renderedLanguage: "txt",
      char: "a",
      count: 80,
    },
    {
      name: "Discord budget",
      minChars: 800,
      maxChars: 2_000,
      marker: "```",
      language: "typescript",
      renderedLanguage: "typescript",
      char: "x",
      count: 3_983,
    },
    {
      name: "tilde budget",
      minChars: 30,
      maxChars: 30,
      marker: "~~~",
      language: "typescript",
      renderedLanguage: "typescript",
      char: "x",
      count: 83,
    },
    {
      name: "indented budget",
      minChars: 40,
      maxChars: 40,
      marker: "  ```",
      language: "typescript",
      renderedLanguage: "typescript",
      char: "x",
      count: 83,
    },
    {
      name: "oversized language metadata",
      minChars: 10,
      maxChars: 30,
      marker: "```",
      language: "very-long-language-name",
      renderedLanguage: "",
      char: "q",
      count: 70,
    },
    {
      name: "smallest bare fence",
      minChars: 1,
      maxChars: 9,
      marker: "```",
      language: "",
      renderedLanguage: "",
      char: "a",
      count: 21,
    },
    {
      name: "smallest language fence",
      minChars: 1,
      maxChars: 13,
      marker: "````",
      language: "js",
      renderedLanguage: "js",
      char: "a",
      count: 21,
    },
  ])(
    "balances fences without losing code or exceeding $name",
    ({ minChars, maxChars, marker, language, renderedLanguage, char, count }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars,
        maxChars,
        breakPreference: "paragraph",
      });
      const body = char.repeat(count);
      chunker.append(`${marker}${language}\n${body}\n${marker}`);
      const chunks = drainChunks(chunker, true);
      expectChunksWithinLength(chunks, maxChars);
      expect(chunks.length).toBeGreaterThan(1);
      expect(Array.from(chunks.join("")).filter((value) => value === char)).toHaveLength(count);
      expect(chunks).not.toContain(`${marker}${language}\n${marker}`);
      expect(chunks.every((chunk) => chunk.trimEnd() !== `${marker}\n${marker}`)).toBe(true);
      expect(
        chunks.map((chunk) => chunk.trimEnd().split("\n").slice(1, -1).join("\n")).join(""),
      ).toBe(body);
      for (const chunk of chunks) {
        expect(chunk.startsWith(`${marker}${renderedLanguage}\n`)).toBe(true);
        expect(chunk.trimEnd().endsWith(marker)).toBe(true);
        expect(chunk.split(marker).length - 1).toBeGreaterThanOrEqual(2);
        expect(chunk).not.toContain(`${marker.slice(0, -1)}\n${marker}`);
        expect(chunk).not.toMatch(/^```txt\n```\n?$/);
      }
    },
  );

  describe("Markdown tables", () => {
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
      const text = Array.from({ length: 60 }, (_, i) => `step ${i}: alpha | beta | gamma`).join(
        "\n",
      );
      for (const delta of [1, 17]) {
        const lengths = (source: string) =>
          streamChunks(source, delta).map((chunk) => chunk.length);
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
});
