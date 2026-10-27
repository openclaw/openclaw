import { describe, expect, it, vi } from "vitest";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  EmbeddedBlockChunker,
  type BlockChunkMetadata,
  type BlockReplyChunking,
} from "./embedded-agent-block-chunker.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

function drainChunks(chunker: EmbeddedBlockChunker, force = false) {
  const chunks: string[] = [];
  chunker.drain({ force, emit: (chunk) => chunks.push(chunk) });
  return chunks;
}

function paragraphChunker(min: number, max: number, options: Partial<BlockReplyChunking> = {}) {
  return new EmbeddedBlockChunker({ minChars: min, maxChars: max, ...options });
}

function renderedCode(text: string) {
  const ir = markdownToIR(text);
  return ir.styles
    .filter((span) => span.style === "code_block")
    .map((span) => ir.text.slice(span.start, span.end));
}

function renderedBody(code: string[]) {
  return code.map((text) => text.replace(/\n$/u, "")).join("");
}

function captureChunks() {
  const chunks: string[] = [];
  const metadata: BlockChunkMetadata[] = [];
  const emitted: [string, string | undefined][] = [];
  const emit = (chunk: string, options?: BlockChunkMetadata) => {
    chunks.push(chunk);
    emitted.push([chunk, options?.sourceText]);
    if (options) {
      metadata.push(options);
    }
  };
  return { chunks, metadata, emitted, emit };
}

function expectChunksWithinLength(chunks: string[], maxLength: number) {
  expect(chunks.filter((chunk) => chunk.length > maxLength)).toStrictEqual([]);
}

function expectDrained(chunker: EmbeddedBlockChunker, length: number) {
  expect(chunker).toMatchObject({ bufferedText: "", consumedLength: length, sourceLength: length });
  expect(chunker.hasBuffered()).toBe(false);
}

function expectSourceCoverage(metadata: BlockChunkMetadata[], source: string) {
  expect(metadata.map((entry) => entry.sourceText).join("")).toBe(source);
  let offset = 0;
  for (const entry of metadata) {
    expect(entry).toMatchObject({
      sourceStart: offset,
      sourceText: source.slice(offset, entry.sourceEnd),
    });
    offset = entry.sourceEnd;
  }
  expect(offset).toBe(source.length);
}

function streamChunks(chunker: EmbeddedBlockChunker, source: string, delta: number, force = false) {
  const capture = captureChunks();
  for (let offset = 0; offset < source.length; offset += delta) {
    chunker.append(source.slice(offset, offset + delta));
    if (!force) {
      chunker.drain({ force: false, emit: capture.emit });
    }
  }
  chunker.drain({ force: true, emit: capture.emit });
  return capture;
}

describe("EmbeddedBlockChunker", () => {
  it("emits a whole leading grapheme that exactly fills the hard cap", () => {
    const cluster = `e${"\u0301".repeat(1199)}`;
    const chunker = paragraphChunker(800, 1200);
    chunker.append(cluster);
    expect(drainChunks(chunker)).toEqual([cluster]);
    expect(chunker.bufferedText).toBe("");

    chunker.append("done");
    expect(drainChunks(chunker)).toEqual([]);
    expect(drainChunks(chunker, true)).toEqual(["done"]);
    expect(chunker.consumedLength).toBe(cluster.length + 4);
  });

  it("keeps a fitting skin tone intact at the normal streaming cap", () => {
    const cluster = "👋🏽";
    const source = `${"x".repeat(1198)}${cluster}done`;
    const insideCluster = new Set([1199, 1200, 1201]);
    for (const deltaSize of [source.length, 17, 1]) {
      for (const force of [false, true]) {
        const chunker = paragraphChunker(800, 1200);
        const { chunks, metadata } = streamChunks(chunker, source, deltaSize, force);
        expect(chunks.join("")).toBe(source);
        expectChunksWithinLength(chunks, 1200);
        expect(chunks.filter((chunk) => chunk.includes(cluster))).toHaveLength(1);
        expectSourceCoverage(metadata, source);
        expect(metadata.every((entry) => !insideCluster.has(entry.sourceEnd))).toBe(true);
        expectDrained(chunker, source.length);
      }
    }
  });

  it("preserves paragraph selection and source cursors across a forced tail", () => {
    const tail = "Cccc";
    for (const force of [false, true]) {
      const prefix = force ? `${"x".repeat(20)}\n` : "";
      const source = `${prefix}Aaaa\n\nBbbb\n\nCccc`;
      const chunker = paragraphChunker(3, 20);
      const { emitted, emit } = captureChunks();
      chunker.append(source);
      chunker.drain({ force, emit });
      expect(emitted).toEqual(
        force
          ? [
              ["x".repeat(20), prefix],
              ["Aaaa", "Aaaa\n\n"],
              ["Bbbb", "Bbbb\n\n"],
              ["Cccc", "Cccc"],
            ]
          : [["Aaaa\n\nBbbb", "Aaaa\n\nBbbb\n\n"]],
      );
      expect(chunker.bufferedText).toBe(force ? "" : tail);
      expect(chunker.hasBuffered()).toBe(!force);
      expect(chunker.consumedLength).toBe(source.length - (force ? 0 : tail.length));
      expect(chunker.sourceLength).toBe(source.length);
      emitted.length = 0;
      chunker.drain({ force: true, emit });
      expect(emitted).toEqual(force ? [] : [[tail, tail]]);
      expectDrained(chunker, source.length);
      expect(drainChunks(chunker, true)).toEqual([]);
    }
  });

  it.each([
    [false, ["    A_153587\n\n", "    B_153587"], "A_153587\n\nB_153587\n"],
    [
      true,
      ["Intro text here.\n\n    line one\n    line two\n\n    line four\n    line five"],
      "line one\nline two\n\nline four\nline five\n",
    ],
  ] as const)("preserves rendered indented code (force=%s)", (force, deltas, code) => {
    const chunker = paragraphChunker(1, 60);
    const chunks: string[] = [];
    for (const delta of deltas) {
      chunker.append(delta);
      if (!force) {
        chunks.push(...drainChunks(chunker));
      }
    }
    chunks.push(...drainChunks(chunker, true));

    expect(chunks.flatMap(renderedCode)).toEqual([code]);
    expectChunksWithinLength(chunks, 60);
    expect(chunker.consumedLength).toBe(deltas.join("").length);
  });

  it("completes Unicode code followed by a long whitespace run before force", async () => {
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
            chunker.drain({ force: false, emit });
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
  });

  it("leaves nested-container Markdown unchanged", () => {
    const source = ">     literal";
    const chunker = paragraphChunker(50, 60);
    chunker.append(source);
    expect(drainChunks(chunker)).toEqual([]);
    expect(drainChunks(chunker, true)).toEqual([source]);
  });

  it("reconciles indented source after a cap without replaying delivered code", () => {
    const chunker = paragraphChunker(10, 60);
    chunker.append(`    ${"A".repeat(56)}old`);
    const first = drainChunks(chunker);
    expect(chunker.consumedLength).toBe(56);
    const snapshot = `    ${"A".repeat(52)}NEW`;
    expect(chunker.replace(snapshot)).toBe(true);
    const chunks = [...first, ...drainChunks(chunker, true)];
    expect(renderedBody(chunks.flatMap(renderedCode))).toBe(`${"A".repeat(52)}NEW`);
    expectDrained(chunker, snapshot.length);
    expect(drainChunks(chunker, true)).toEqual([]);
  });

  it("balances forced open-fence checkpoints and preserves continuation source", () => {
    for (const { opener, body, renderedOpener } of [
      { opener: "```txt\n", body: "abc", renderedOpener: "```txt\n" },
      { opener: "```txt\n", body: "abcdefghijklmnop", renderedOpener: "```txt\n" },
      { opener: "```abcdefghijkl\n", body: "a", renderedOpener: "```\n" },
    ]) {
      const chunker = paragraphChunker(1, 20);
      const { chunks, metadata: sources, emit } = captureChunks();
      const checkpoint = opener + body;
      chunker.append(checkpoint);
      chunker.drain({ force: false, emit });
      chunker.replace(checkpoint, 0, true);
      chunker.drain({ force: true, emit });
      expect(chunks.every((chunk) => chunk.startsWith(renderedOpener))).toBe(true);
      expect(chunks.every((chunk) => chunk.endsWith("\n```"))).toBe(true);
      expectDrained(chunker, checkpoint.length);

      const continuation = `\n${"abcdefghijklmnopqrstuvwxyz".slice(body.length)}\n\`\`\``;
      const source = checkpoint + continuation;
      chunker.append(continuation);
      chunker.drain({ force: true, emit });
      expect(chunks.every((chunk) => chunk.startsWith(renderedOpener))).toBe(true);
      expect(chunks.every((chunk) => chunk.endsWith("\n```"))).toBe(true);
      expect(
        chunks.map((chunk) => chunk.slice(renderedOpener.length, -4).replaceAll("\n", "")).join(""),
      ).toBe("abcdefghijklmnopqrstuvwxyz");
      expectChunksWithinLength(chunks, 20);
      expect(sources).toHaveLength(chunks.length);
      expectSourceCoverage(sources, source);
      expectDrained(chunker, source.length);
      expect(drainChunks(chunker, true)).toEqual([]);
    }
  });

  it("keeps streamed fence boundaries intact at punctuation at the cap", () => {
    const chunker = paragraphChunker(8, 20);
    chunker.append("```ts\nabcdefghijklm.");
    expect(drainChunks(chunker)).toEqual(["```ts\nabcdefghij\n```"]);
  });

  it("reports original source across synthetic wrappers with a preserved break", () => {
    const chunker = paragraphChunker(1, 20);
    const { emitted, emit } = captureChunks();
    const fenced = "```txt\nabcdefghijklmnopqr\n```\n\n";
    chunker.reset([fenced.length]);
    chunker.append(`${fenced}Tail`);
    chunker.drain({ force: true, emit });

    expect(emitted).toEqual([
      ["```txt\nabcdefghi\n```", "```txt\nabcdefghi"],
      ["```txt\njklmnopqr\n```", "jklmnopqr\n```\n\n"],
      ["Tail", "Tail"],
    ]);
  });

  it("preserves code and source coverage across shortened fence metadata and indented code", () => {
    const body = `${"A".repeat(56)} TAIL`;
    const source = `\`\`\`${"language".repeat(20)}\nreal\n\`\`\`\n\n    ${body}`;
    const chunker = paragraphChunker(1, 60);
    const { chunks, metadata, emit } = captureChunks();
    chunker.append(source);
    chunker.drain({ force: true, emit });
    const code = chunks.flatMap(renderedCode);
    expect(code[0]).toBe("real\n");
    expect(renderedBody(code.slice(1))).toBe(body);
    expectSourceCoverage(metadata, source);
    expect(chunker.consumedLength).toBe(source.length);
    expectChunksWithinLength(chunks, 60);
  });

  it("drains a preserved short prefix below the cap on force without merging its suffix", () => {
    const chunker = paragraphChunker(12, 50, { breakPreference: "newline" });
    const prefix = "Corrected. ";
    const suffix = "Unchanged paragraph follows.\n";
    chunker.reset([prefix.length]);
    chunker.append(prefix + suffix);

    expect(drainChunks(chunker)).toEqual([]);
    expect(chunker.bufferedText).toBe(prefix + suffix);
    expect(drainChunks(chunker, true)).toEqual([prefix, suffix]);
    expect(chunker.bufferedText).toBe("");
  });

  it("replaces a pending preserved boundary before introducing a code fence", () => {
    const chunker = paragraphChunker(1, 50);
    const prefix = "Corrected. ";
    chunker.reset([prefix.length]);
    chunker.append(`${prefix}Unchanged prose follows.`);
    const replacement = "```txt\nA revised fenced answer.\n```";

    chunker.replace(replacement);

    expect(drainChunks(chunker, true)).toEqual([replacement]);
    expect(chunker.bufferedText).toBe("");
  });

  it("reconciles an empty pending tail without replaying drained source", () => {
    const chunker = paragraphChunker(10, 16, { breakPreference: "sentence" });
    for (const sentence of ["Hello world.", "Next sentence."]) {
      chunker.append(`${sentence} `);
      expect(drainChunks(chunker)).toEqual([sentence]);
    }
    chunker.append("Tail");
    expect(chunker.consumedLength).toBe("Hello world. Next sentence. ".length);
    const snapshot = "Hello world. Next sentence.";

    expect(chunker.replace(snapshot)).toBe(true);
    expect(chunker.sourceLength).toBe(snapshot.length);
    expect(drainChunks(chunker, true)).toEqual([]);
    expect(chunker.consumedLength).toBe(snapshot.length);
    expect(chunker.replace(snapshot)).toBe(false);
    expect(drainChunks(chunker, true)).toEqual([]);
  });

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

  it("reconciles long-language fenced source with empty pending code", () => {
    const header = "```very-long-language-name\n";
    const body = "q".repeat(22);
    const chunker = paragraphChunker(10, 30);
    chunker.append(`${header}${body}qqqq\nold\n\`\`\``);
    expect(drainChunks(chunker)).toEqual([`\`\`\`\n${body}\n\`\`\``]);
    expect(chunker.consumedLength).toBe(header.length + body.length);

    const snapshot = `${header}${body}\n\`\`\``;
    expect(chunker.replace(snapshot)).toBe(true);
    expect(chunker.sourceLength).toBe(snapshot.length);
    expect(chunker.bufferedText).toBe("```\n\n```");
    expect(drainChunks(chunker, true)).toEqual([]);
    expect(chunker.consumedLength).toBe(snapshot.length);
  });

  it("respects paragraph boundaries and minimum paragraph length", () => {
    const chunker = paragraphChunker(30, 200, { flushOnParagraph: true });
    chunker.append("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
    expect(drainChunks(chunker)).toEqual(["First paragraph.\n\nSecond paragraph."]);
    expect(chunker.bufferedText).toBe("Third paragraph.");
  });

  it.each([
    [1, 20, `${"x".repeat(19)}😀tail`, ["x".repeat(19)], "😀tail"],
    [1, 1, "😀tail", ["😀", "t", "a", "i", "l"], ""],
    [
      10,
      20,
      `\`\`\`txt\n${"x".repeat(12)}😀tail`,
      [`\`\`\`txt\n${"x".repeat(9)}\n\`\`\``],
      "```txt\nxxx😀tail",
    ],
  ] as const)(
    "keeps min=%i/max=%i chunks valid at UTF-16 boundaries",
    (min, max, source, chunks, pending) => {
      const chunker = paragraphChunker(min, max);
      chunker.append(source);
      expect(drainChunks(chunker)).toEqual(chunks);
      expect(chunker.bufferedText).toBe(pending);
    },
  );

  it("bounds paragraph candidate scans while streaming a long open fence", () => {
    const maxChars = 1_200;
    const chunker = paragraphChunker(1, maxChars, {
      breakPreference: "newline",
      flushOnParagraph: true,
    });
    const code = "code\n\n".repeat(600);
    const closing = "```\n\nAfter";
    const initial = `\`\`\`txt\n${code}`;
    const completed = `\`\`\`txt\n${code}${closing}`;
    const { chunks, metadata, emit } = captureChunks();
    chunker.append(initial);
    let candidates = 0;
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
    } finally {
      spy.mockRestore();
    }
    const streamedCount = chunks.length;
    expect(streamedCount).toBeGreaterThan(1);
    expect(chunker.sourceLength).toBe(initial.length);
    chunker.append(closing);
    chunker.drain({ force: true, emit });

    expectSourceCoverage(metadata, completed);
    expectDrained(chunker, completed.length);
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
  });

  it("preserves the final content line in an unfinished backtick fence on force", () => {
    const finalLine = "    ``` XXXXXXXX";
    const chunker = paragraphChunker(1, 20);
    chunker.append(`\`\`\`txt\n12345678\n${finalLine}`);

    const chunks = drainChunks(chunker, true);

    expectChunksWithinLength(chunks, 20);
    expect(Array.from(chunks.join("")).filter((value) => value === "X")).toHaveLength(8);
    expect(chunker.bufferedText).toBe("");
  });

  it("recognizes a backtick closing fence with surrounding whitespace", () => {
    const chunker = paragraphChunker(1, 20);
    chunker.append(`\`\`\`txt\n${"q".repeat(32)}\n   \`\`\` \t`);

    const chunks = drainChunks(chunker, true);

    expectChunksWithinLength(chunks, 20);
    expect(chunks.join("").match(/q/g)).toHaveLength(32);
    expect(chunks.every((chunk) => chunk.includes("q"))).toBe(true);
    expect(chunker.bufferedText).toBe("");
  });

  describe("Markdown tables", () => {
    const chunking = { minChars: 800, maxChars: 1200, breakPreference: "paragraph" } as const;
    const intro = "Here is the quarterly summary you asked for.";
    const capRows = "| Region | Total |\n| --- | ---: |\n| North | 1100 |";
    const tableAtCap = capRows.replace(
      "Region",
      `Region${" ".repeat(chunking.maxChars - capRows.length)}`,
    );

    const tableChunks = (text: string, delta: number) =>
      streamChunks(new EmbeddedBlockChunker(chunking), text, delta).chunks;

    it("keeps a streamed table whole when it fills maxChars and a heading follows directly", () => {
      const text = `${intro}\n\n${tableAtCap}\n# Next steps`;
      for (const delta of [1, 17, 43, text.length]) {
        expect(tableChunks(text, delta)).toEqual([intro, tableAtCap, "# Next steps"]);
      }
    });

    it("streams pipe-bearing prose at the same boundaries as plain prose", () => {
      const text = Array.from({ length: 60 }, (_, i) => `step ${i}: alpha | beta | gamma`).join(
        "\n",
      );
      for (const delta of [1, 17]) {
        const lengths = (source: string) => tableChunks(source, delta).map((chunk) => chunk.length);
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
