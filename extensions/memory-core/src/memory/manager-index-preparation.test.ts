import { describe, expect, it } from "vitest";
import { prepareMemoryIndexChunks } from "./manager-index-preparation.js";

describe("prepareMemoryIndexChunks", () => {
  it("excludes daily-note frontmatter while preserving body citation lines", () => {
    const content = [
      "---",
      'title: "Daily Notes — 2026-09-05"',
      "date: 2026-09-05",
      "type: daily",
      "tags: [memory, daily]",
      "status: active",
      "---",
      "# 2026-09-05",
      "Durable body content.",
    ].join("\n");

    const result = prepareMemoryIndexChunks({
      entry: { path: "memory/2026-09-05.md", mtimeMs: 1 },
      source: "memory",
      content,
      pathClassification: { curatedRoot: false, originClass: "agent" },
      chunking: { tokens: 400, overlap: 80 },
      hardMaxInputTokens: 8_192,
    });

    expect(result.contentHash).toBeTruthy();
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      startLine: 8,
      endLine: 9,
      text: "# 2026-09-05\nDurable body content.",
    });
    expect(result.chunks[0]?.text).not.toContain("status: active");
  });
});
