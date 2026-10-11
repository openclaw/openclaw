import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareMemoryIndexChunks } from "./manager-index-preparation.js";

describe("heading chunks at the indexing boundary", () => {
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
        embeddingInput: { text: content },
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
