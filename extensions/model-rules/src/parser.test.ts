import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractSection,
  findModelSection,
  parseModelRef,
  readModelsFile,
  resetFileCache,
} from "./parser.js";

describe("parseModelRef", () => {
  it("splits provider/model into fullRef and bareId", () => {
    expect(parseModelRef("openai/gpt-5.4")).toEqual({
      fullRef: "openai/gpt-5.4",
      bareId: "gpt-5.4",
    });
  });

  it("returns same value for both fields when no provider prefix", () => {
    expect(parseModelRef("gpt-5.4")).toEqual({
      fullRef: "gpt-5.4",
      bareId: "gpt-5.4",
    });
  });

  it("handles multiple slashes by splitting on the last", () => {
    expect(parseModelRef("a/b/c")).toEqual({
      fullRef: "a/b/c",
      bareId: "c",
    });
  });

  it("handles nested provider refs like openrouter/anthropic/model", () => {
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-4-6")).toEqual({
      fullRef: "openrouter/anthropic/claude-sonnet-4-6",
      bareId: "claude-sonnet-4-6",
    });
  });

  it("trims whitespace", () => {
    expect(parseModelRef("  openai/gpt-5.4  ")).toEqual({
      fullRef: "openai/gpt-5.4",
      bareId: "gpt-5.4",
    });
  });

  it("handles empty string", () => {
    expect(parseModelRef("")).toEqual({ fullRef: "", bareId: "" });
  });
});

describe("extractSection", () => {
  const content = `# Per-Model Corrective Instructions

## MODEL: gpt-5.4

Never describe what you would do — do it.
Show proof of completion.

## MODEL: claude-sonnet-4-6

Verify your work after every action.

## MODEL: deepseek-r1

Show reasoning step by step.
`;

  it("extracts the correct section by exact model ID", () => {
    const result = extractSection(content, "gpt-5.4");
    expect(result).toContain("Never describe what you would do");
    expect(result).toContain("Show proof of completion");
  });

  it("does not include content from other sections", () => {
    const result = extractSection(content, "gpt-5.4");
    expect(result).not.toContain("Verify your work");
    expect(result).not.toContain("reasoning step by step");
  });

  it("extracts the last section without a trailing heading", () => {
    const result = extractSection(content, "deepseek-r1");
    expect(result).toContain("Show reasoning step by step");
  });

  it("returns null for a missing model", () => {
    expect(extractSection(content, "nonexistent-model")).toBeNull();
  });

  it("returns null for an empty modelId", () => {
    expect(extractSection(content, "")).toBeNull();
  });

  it("returns null when section body is empty", () => {
    const sparse = "## MODEL: empty-model\n\n## MODEL: next\n\nhas content\n";
    expect(extractSection(sparse, "empty-model")).toBeNull();
  });

  it("matches case-insensitively", () => {
    const result = extractSection(content, "GPT-5.4");
    expect(result).toContain("Never describe what you would do");
  });

  it("handles Windows line endings", () => {
    const winContent = "## MODEL: win-model\r\nRule one.\r\nRule two.\r\n## MODEL: other\r\n";
    const result = extractSection(winContent, "win-model");
    expect(result).toContain("Rule one.");
    expect(result).toContain("Rule two.");
  });

  it("matches heading with tab before line break", () => {
    const tabContent = "## MODEL: tab-model\t\nRule with tab heading.\n";
    const result = extractSection(tabContent, "tab-model");
    expect(result).toContain("Rule with tab heading.");
  });

  it("matches heading with trailing whitespace before line break", () => {
    const wsContent = "## MODEL: ws-model   \nRule with trailing spaces.\n";
    const result = extractSection(wsContent, "ws-model");
    expect(result).toContain("Rule with trailing spaces.");
  });

  it("truncates section at ## MODEL: line inside body (known limitation)", () => {
    const bodyContent = [
      "## MODEL: example-model",
      "",
      "When documenting rules, do not write lines like:",
      "## MODEL: some-other-id",
      "because it confuses the parser.",
      "",
      "## MODEL: real-next",
      "",
      "Next section content.",
    ].join("\n");
    const result = extractSection(bodyContent, "example-model");
    expect(result).toContain("do not write lines like");
    // Known limitation: parser is line-based and treats any line starting with
    // ## MODEL: as a section boundary. Content after the false heading is lost.
    expect(result).not.toContain("because it confuses the parser");
  });

  it("handles duplicate headings by returning the first match", () => {
    const dupes = "## MODEL: dupe\n\nFirst.\n\n## MODEL: dupe\n\nSecond.\n";
    const result = extractSection(dupes, "dupe");
    expect(result).toContain("First.");
    expect(result).not.toContain("Second.");
  });
});

describe("findModelSection", () => {
  const content = `## MODEL: openai/gpt-5.4

Full ref rules here.

## MODEL: gpt-5.4

Bare ID rules here.

## MODEL: claude-sonnet-4-6

Claude rules.
`;

  it("prefers full ref match over bare ID", () => {
    const result = findModelSection(content, "openai/gpt-5.4");
    expect(result).toContain("Full ref rules here");
    expect(result).not.toContain("Bare ID rules here");
  });

  it("falls back to bare ID when no full ref section exists", () => {
    const result = findModelSection(content, "anthropic/claude-sonnet-4-6");
    expect(result).toContain("Claude rules");
  });

  it("matches bare ID directly when no provider prefix", () => {
    const bareContent = "## MODEL: gpt-5.4\n\nBare only.\n";
    const result = findModelSection(bareContent, "gpt-5.4");
    expect(result).toContain("Bare only");
  });

  it("returns null when no section matches", () => {
    expect(findModelSection(content, "missing/model")).toBeNull();
  });
});

describe("readModelsFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetFileCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-rules-test-"));
  });

  afterEach(async () => {
    resetFileCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a MODELS.md file from the workspace", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: test\n\nTest rules.\n");
    const result = await readModelsFile(tmpDir);
    expect(result).toContain("## MODEL: test");
    expect(result).toContain("Test rules.");
  });

  it("returns null when the file does not exist", async () => {
    const result = await readModelsFile(tmpDir);
    expect(result).toBeNull();
  });

  it("reads a custom filename", async () => {
    await fs.writeFile(path.join(tmpDir, "custom.md"), "## MODEL: custom\n\nCustom rules.\n");
    const result = await readModelsFile(tmpDir, "custom.md");
    expect(result).toContain("Custom rules.");
  });

  it("returns cached content when mtime has not changed", async () => {
    const filePath = path.join(tmpDir, "MODELS.md");
    await fs.writeFile(filePath, "## MODEL: cached\n\nOriginal.\n");
    const first = await readModelsFile(tmpDir);
    const second = await readModelsFile(tmpDir);
    expect(first).toBe(second);
  });

  it("rejects path traversal filenames", async () => {
    const result = await readModelsFile(tmpDir, "../escape.md");
    expect(result).toBeNull();
  });

  it("rejects filenames that resolve to workspace root itself", async () => {
    const result = await readModelsFile(tmpDir, "");
    expect(result).toBeNull();
  });

  it("rejects absolute path filenames outside workspace", async () => {
    const result = await readModelsFile(tmpDir, "/etc/passwd");
    expect(result).toBeNull();
  });

  it("rejects symlink pointing outside workspace", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-rules-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "secret.md");
      await fs.writeFile(outsideFile, "## MODEL: leaked\n\nSecret data.\n");
      const linkPath = path.join(tmpDir, "MODELS.md");
      try {
        await fs.symlink(outsideFile, linkPath);
      } catch {
        return; // symlinks not supported (e.g. Windows without privileges)
      }
      const result = await readModelsFile(tmpDir);
      expect(result).toBeNull();
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("refreshes cache when file content changes", async () => {
    const filePath = path.join(tmpDir, "MODELS.md");
    await fs.writeFile(filePath, "## MODEL: v1\n\nVersion 1.\n");
    const first = await readModelsFile(tmpDir);
    expect(first).toContain("Version 1.");

    // small delay to ensure mtime changes
    await new Promise((r) => setTimeout(r, 50));
    await fs.writeFile(filePath, "## MODEL: v2\n\nVersion 2.\n");
    const second = await readModelsFile(tmpDir);
    expect(second).toContain("Version 2.");
  });

  it("caches multiple workspaces independently", async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "model-rules-a-"));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "model-rules-b-"));
    try {
      await fs.writeFile(path.join(dirA, "MODELS.md"), "## MODEL: a\n\nRules A.\n");
      await fs.writeFile(path.join(dirB, "MODELS.md"), "## MODEL: b\n\nRules B.\n");
      const resultA = await readModelsFile(dirA);
      const resultB = await readModelsFile(dirB);
      expect(resultA).toContain("Rules A.");
      expect(resultB).toContain("Rules B.");
      const resultA2 = await readModelsFile(dirA);
      expect(resultA2).toContain("Rules A.");
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });
});
