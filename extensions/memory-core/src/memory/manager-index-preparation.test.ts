import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import { prepareMemoryIndexChunks } from "./manager-index-preparation.js";

describe("heading chunks at the indexing boundary", () => {
  it("retains invalid project scope on a heading with an unterminated annotation", () => {
    const { chunks } = prepareMemoryIndexChunks({
      entry: { path: "MEMORY.md", mtimeMs: 1 },
      source: "memory",
      content: "# Private <!-- project: alpha-key\n- Global neighbor. <!-- trigger: global -->",
      pathClassification: { curatedRoot: true, originClass: "agent" },
      chunking: { tokens: 400, overlap: 80 },
      hardMaxInputTokens: 8192,
    });
    expect(chunks.map(({ text, projectKey }) => ({ text, projectKey }))).toEqual([
      { text: "# Private <!-- project: alpha-key", projectKey: "!invalid-project-annotation" },
      { text: "- Global neighbor.", projectKey: null },
    ]);
  });

  it("keeps a heading fragment with its containing curated entry's annotations", () => {
    const { chunks } = prepareMemoryIndexChunks({
      entry: { path: "MEMORY.md", mtimeMs: 1 },
      source: "memory",
      content: [
        "- Scoped entry. <!-- project: alpha-key -->",
        "  ## Private heading",
        "- Global neighbor. <!-- trigger: global -->",
      ].join("\n"),
      pathClassification: { curatedRoot: true, originClass: "agent" },
      chunking: { tokens: 8, overlap: 0 },
      hardMaxInputTokens: 8192,
    });
    expect(
      chunks.map(({ text, projectKey, triggers }) => ({ text, projectKey, triggers })),
    ).toEqual([
      { text: "- Scoped entry.", projectKey: "alpha-key", triggers: null },
      { text: "  ## Private heading", projectKey: "alpha-key", triggers: null },
      { text: "- Global neighbor.", projectKey: null, triggers: "global" },
    ]);
  });

  it.each([0, 2])("keeps a whole heading when chunk overlap is %s", (overlap) => {
    const content = "# Plan\nThe irrigation starts at dawn.";
    const { chunks } = prepareMemoryIndexChunks({
      entry: { path: "memory/notes.md", mtimeMs: 1 },
      source: "memory",
      content,
      pathClassification: { curatedRoot: false, originClass: "agent" },
      chunking: { tokens: 8, overlap },
      hardMaxInputTokens: 8192,
    });

    expect(chunks).toEqual([
      expect.objectContaining({
        startLine: 1,
        endLine: 2,
        text: content,
        hash: createHash("sha256").update(content).digest("hex"),
      }),
    ]);
  });

  it("preserves a long heading continuation that shares the next chunk's source line", () => {
    const { chunks } = prepareMemoryIndexChunks({
      entry: { path: "memory/notes.md", mtimeMs: 1 },
      source: "memory",
      content: `# ${"a".repeat(32)}\nBody`,
      pathClassification: { curatedRoot: false, originClass: "agent" },
      chunking: { tokens: 8, overlap: 0 },
      hardMaxInputTokens: 8192,
    });
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(`# ${"a".repeat(32)}\nBody`);
  });

  it.each(["memory", "sessions"] as const)("preserves a final heading for %s", (source) => {
    const { chunks } = prepareMemoryIndexChunks({
      entry: { path: "MEMORY.md", mtimeMs: 1 },
      source,
      content: "## Unfinished",
      pathClassification: { curatedRoot: true, originClass: "agent" },
      chunking: { tokens: 400, overlap: 80 },
      hardMaxInputTokens: 8192,
    });
    expect(chunks.map((chunk) => chunk.text)).toEqual(["## Unfinished"]);
  });
});

describe("plain-text indexing worker payload", () => {
  it.each([undefined, { id: "test", maxInputTokens: 4096 }])(
    "transfers source text once, including provider-limited fragments (%j)",
    (provider) => {
      const content = "a".repeat(64 * 1024);
      const prepared = prepareMemoryIndexChunks({
        entry: { path: "sessions/large.jsonl", mtimeMs: 1 },
        source: "sessions",
        content,
        pathClassification: { curatedRoot: false, originClass: "agent" },
        chunking: { tokens: 20_000, overlap: 0 },
        provider,
        hardMaxInputTokens: 8192,
      });

      expect(prepared.chunks.map((chunk) => chunk.text).join("")).toBe(content);
      expect(serialize(prepared).byteLength).toBeLessThan(80 * 1024);
    },
  );
});
