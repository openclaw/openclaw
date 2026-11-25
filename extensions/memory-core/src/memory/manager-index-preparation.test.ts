import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { expect, it } from "vitest";
import {
  prepareMemoryIndexChunks,
  type MemoryIndexPreparationInput,
} from "./manager-index-preparation.js";

const prepare = (content: string, overrides: Partial<MemoryIndexPreparationInput> = {}) =>
  prepareMemoryIndexChunks({
    entry: { path: "MEMORY.md", mtimeMs: 1 },
    source: "memory",
    content,
    pathClassification: { curatedRoot: true, originClass: "agent" },
    chunking: { tokens: 400, overlap: 80 },
    hardMaxInputTokens: 8192,
    ...overrides,
  });

const prepareHeading = (content: string, overlap = 0) =>
  prepare(content, {
    entry: { path: "memory/notes.md", mtimeMs: 1 },
    pathClassification: { curatedRoot: false, originClass: "agent" },
    chunking: { tokens: 8, overlap },
  });

it("retains invalid scope on an unterminated heading annotation", () => {
  const { chunks } = prepare(
    "# Private <!-- project: alpha-key\n- Global neighbor. <!-- trigger: global -->",
  );
  expect(chunks.map(({ text, projectKey }) => ({ text, projectKey }))).toEqual([
    { text: "# Private <!-- project: alpha-key", projectKey: "!invalid-project-annotation" },
    { text: "- Global neighbor.", projectKey: null },
  ]);
});

it("keeps a heading fragment's curated-entry annotations", () => {
  const { chunks } = prepare(
    "- Scoped entry. <!-- project: alpha-key -->\n  ## Private heading\n- Global neighbor. <!-- trigger: global -->",
    { chunking: { tokens: 8, overlap: 0 } },
  );
  expect(chunks).toMatchObject([
    { text: "- Scoped entry.", projectKey: "alpha-key", triggers: null },
    { text: "  ## Private heading", projectKey: "alpha-key", triggers: null },
    { text: "- Global neighbor.", projectKey: null, triggers: "global" },
  ]);
});

it.each([0, 2])("keeps a whole heading when chunk overlap is %s", (overlap) => {
  const content = "# Plan\nThe irrigation starts at dawn.";
  const hash = createHash("sha256").update(content).digest("hex");
  const { chunks } = prepareHeading(content, overlap);
  expect(chunks).toMatchObject([{ startLine: 1, endLine: 2, text: content, hash }]);
});

it("preserves a heading continuation sharing the next chunk's source line", () => {
  const { chunks } = prepareHeading(`# ${"a".repeat(32)}\nBody`);
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(`# ${"a".repeat(32)}\nBody`);
});

it.each(["memory", "sessions"] as const)("preserves a final heading for %s", (source) => {
  const { chunks } = prepare("## Unfinished", { source });
  expect(chunks.map((chunk) => chunk.text)).toEqual(["## Unfinished"]);
});

it.each([undefined, { id: "test", maxInputTokens: 4096 }])(
  "transfers plain text once, including provider-limited fragments (%j)",
  (provider) => {
    const content = "a".repeat(64 * 1024);
    const prepared = prepare(content, {
      entry: { path: "sessions/large.jsonl", mtimeMs: 1 },
      source: "sessions",
      pathClassification: { curatedRoot: false, originClass: "agent" },
      chunking: { tokens: 20_000, overlap: 0 },
      provider,
    });

    expect(prepared.chunks.map((chunk) => chunk.text).join("")).toBe(content);
    expect(serialize(prepared).byteLength).toBeLessThan(80 * 1024);
  },
);
