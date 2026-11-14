// A fence split across chunks must be classified like the one-shot scan of the whole text.
import { describe, expect, it } from "vitest";
import { parseFenceSpans, scanFenceSpans } from "./fences.js";

const splitAt = (text: string, cuts: readonly number[]): string[] => {
  const bounds = [0, ...cuts, text.length];
  return bounds.slice(0, -1).map((start, index) => text.slice(start, bounds[index + 1]));
};

type Scanned = ReturnType<typeof scanFenceSpans>;
type ScanState = Parameters<typeof scanFenceSpans>[1];

/** Same containment rule buildCodeSpanIndex uses: a span covers its own start offset. */
const covers = (scanned: Scanned["spans"], index: number) =>
  scanned.some((span) => index >= span.start && index < span.end);

/**
 * Compares every offset whose classification the next chunk cannot still change: complete lines,
 * and the whole last chunk. A trailing partial line is where a fence may still begin, so the
 * streaming scanner is allowed to be undecided there — the end state covers it instead.
 */
function expectFenceChunkInvariant(text: string, cuts: readonly number[]) {
  const oneShot = parseFenceSpans(text);
  const chunks = splitAt(text, cuts);
  let state: ScanState;
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    const scanned = scanFenceSpans(chunk, state);
    const isLast = index === chunks.length - 1;
    const settled = isLast || chunk.endsWith("\n") ? chunk.length : chunk.lastIndexOf("\n") + 1;
    for (let local = 0; local < settled; local += 1) {
      expect({ at: offset + local, inside: covers(scanned.spans, local) }).toEqual({
        at: offset + local,
        inside: covers(oneShot, offset + local),
      });
    }
    state = scanned.state;
    offset += chunk.length;
  }
  expect(state?.open !== undefined).toBe(covers(oneShot, text.length - 1));
}

const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

describe("scanFenceSpans chunk invariance", () => {
  it("keeps a fence whose indentation and marker are split across the boundary", () => {
    // "a\n  ```\ncode\n```\n": the opener starts at offset 2, two spaces into the line.
    for (const cuts of [[3], [4], [5], [3, 4], [4, 5]]) {
      expectFenceChunkInvariant("a\n  ```\ncode\n```\n", cuts);
    }
  });

  it("keeps a fence whose opening marker is split mid-run", () => {
    for (const cuts of [[1], [2], [1, 2]]) {
      expectFenceChunkInvariant("```\ncode\n```\n", cuts);
    }
  });

  it("closes a fence whose closing marker is split mid-run", () => {
    // Without the carried run the fence stays open and swallows the trailing paragraph.
    expectFenceChunkInvariant("```\ncode\n```\ntail\n", [10]);
    expectFenceChunkInvariant("```\ncode\n```\ntail\n", [9, 11]);
  });

  it("handles tilde fences and an indented marker line split the same ways", () => {
    expectFenceChunkInvariant("a\n   ~~~\ncode\n~~~\n", [4]);
    expectFenceChunkInvariant("intro\n```ts\nconst a = 1;\n```\ntail\n", [8]);
  });

  it("survives an empty chunk between the halves of a split marker line", () => {
    expectFenceChunkInvariant("a\n  ```\ncode\n```\n", [3, 3]);
  });

  it("stays invariant over generated fence documents", () => {
    const random = seeded(20_261_102);
    const shapes = [
      (body: string) => `a\n  \`\`\`\n${body}\n\`\`\`\ntail\n`,
      (body: string) => `\`\`\`\n${body}\n\`\`\`\ntail\n`,
      (body: string) => `a\n   ~~~\n${body}\n~~~\ntail\n`,
    ];
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const body = ["code", "const a = 1;", "`inline`", ""][Math.floor(random() * 4)] ?? "code";
      const shape =
        shapes[Math.floor(random() * shapes.length)] ??
        ((b: string) => `a\n  \`\`\`\n${b}\n\`\`\`\ntail\n`);
      const text = shape(body);
      const cuts = [1 + Math.floor(random() * (text.length - 1))];
      expectFenceChunkInvariant(text, cuts);
    }
  });
});
