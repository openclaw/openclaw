import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSemanticCompletionPrompt,
  buildSemanticLoaderPrompt,
  isExpectedSemanticPromptFile,
  resolveSemanticExpectedFiles,
  type SemanticPromptFiles,
  writeSemanticSessionFile,
} from "./semantic-prompt.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sem-prompt-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// writeSemanticSessionFile
// ---------------------------------------------------------------------------

describe("writeSemanticSessionFile", () => {
  it("writes session file and returns non-empty hash", async () => {
    const dir = await makeTmpDir();
    const sessionFile = path.join(dir, "sess");
    const content = "hello world\n";

    const result = await writeSemanticSessionFile({
      sessionFile,
      sessionPromptContent: content,
    });

    const written = await fs.readFile(result.filePath, "utf-8");
    expect(written).toBe(content);
    expect(result.filePath).toBe(path.join(dir, "sess.system-prompt.txt"));
    expect(typeof result.hash).toBe("string");
    expect(result.hash.length).toBeGreaterThan(0);
  });

  it("skips write when content is unchanged", async () => {
    const dir = await makeTmpDir();
    const sessionFile = path.join(dir, "sess");
    const content = "stable content\n";

    const first = await writeSemanticSessionFile({
      sessionFile,
      sessionPromptContent: content,
    });
    const statBefore = await fs.stat(first.filePath);

    // Small delay so mtime would differ if the file were rewritten.
    await new Promise((r) => setTimeout(r, 50));

    const second = await writeSemanticSessionFile({
      sessionFile,
      sessionPromptContent: content,
    });

    const statAfter = await fs.stat(second.filePath);
    expect(second.hash).toBe(first.hash);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("appends newline if missing", async () => {
    const dir = await makeTmpDir();
    const sessionFile = path.join(dir, "sess");

    await writeSemanticSessionFile({
      sessionFile,
      sessionPromptContent: "no trailing newline",
    });

    const written = await fs.readFile(path.join(dir, "sess.system-prompt.txt"), "utf-8");
    expect(written.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSemanticLoaderPrompt
// ---------------------------------------------------------------------------

describe("buildSemanticLoaderPrompt", () => {
  const files: SemanticPromptFiles = {
    contextFiles: ["/a/AGENTS.md", "/a/SOUL.md"],
    sessionFile: "/b/session.system-prompt.txt",
    sessionHash: "abc123",
  };

  it("lists session file first, context files after", () => {
    const out = buildSemanticLoaderPrompt({
      files,
      reason: "new-session",
    });
    expect(out).toContain("1. /b/session.system-prompt.txt");
    expect(out).toContain("2. /a/AGENTS.md");
    expect(out).toContain("3. /a/SOUL.md");
  });

  it("contains parallel instruction", () => {
    const out = buildSemanticLoaderPrompt({
      files,
      reason: "new-session",
    });
    expect(out).toContain("any order and in parallel");
  });

  it("does NOT contain sequential instruction", () => {
    const out = buildSemanticLoaderPrompt({
      files,
      reason: "new-session",
    });
    expect(out).not.toContain("exact order");
    expect(out).not.toContain("sequentially");
  });

  it("prepends strict message when strict is true", () => {
    const out = buildSemanticLoaderPrompt({
      files,
      reason: "new-session",
      strict: true,
    });
    expect(out.startsWith("Your previous attempt")).toBe(true);
  });

  it("prepends compaction message when reason is compaction", () => {
    const out = buildSemanticLoaderPrompt({
      files,
      reason: "compaction",
    });
    expect(out).toContain("compacted or summarized");
  });
});

// ---------------------------------------------------------------------------
// buildSemanticCompletionPrompt
// ---------------------------------------------------------------------------

describe("buildSemanticCompletionPrompt", () => {
  const files: SemanticPromptFiles = {
    contextFiles: ["/a/AGENTS.md", "/a/SOUL.md"],
    sessionFile: "/b/session.system-prompt.txt",
    sessionHash: "abc123",
  };

  it("lists only unverified paths", () => {
    const out = buildSemanticCompletionPrompt({
      files,
      unverifiedPaths: ["/a/AGENTS.md"],
    });
    expect(out).toContain("1. /a/AGENTS.md");
    expect(out).not.toContain("/a/SOUL.md");
    expect(out).not.toContain("/b/session.system-prompt.txt");
  });

  it("contains mandatory instruction", () => {
    const out = buildSemanticCompletionPrompt({
      files,
      unverifiedPaths: ["/a/AGENTS.md"],
    });
    expect(out).toContain("MANDATORY NEXT STEP");
  });
});

// ---------------------------------------------------------------------------
// isExpectedSemanticPromptFile
// ---------------------------------------------------------------------------

describe("isExpectedSemanticPromptFile", () => {
  const files: SemanticPromptFiles = {
    contextFiles: ["/a/AGENTS.md", "/a/SOUL.md"],
    sessionFile: "/b/session.system-prompt.txt",
    sessionHash: "abc123",
  };

  it("matches a context file", () => {
    expect(isExpectedSemanticPromptFile(files, "/a/AGENTS.md")).toBe(true);
  });

  it("matches the session file", () => {
    expect(isExpectedSemanticPromptFile(files, "/b/session.system-prompt.txt")).toBe(true);
  });

  it("rejects unknown file", () => {
    expect(isExpectedSemanticPromptFile(files, "/c/other.md")).toBe(false);
  });

  it("resolves relative paths", () => {
    const cwd = process.cwd();
    const absFile = path.join(cwd, "relative.md");
    const filesWithRelative: SemanticPromptFiles = {
      contextFiles: [absFile],
      sessionFile: "/b/session.system-prompt.txt",
      sessionHash: "abc123",
    };
    expect(isExpectedSemanticPromptFile(filesWithRelative, "relative.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSemanticExpectedFiles
// ---------------------------------------------------------------------------

describe("resolveSemanticExpectedFiles", () => {
  const files: SemanticPromptFiles = {
    contextFiles: ["/a/AGENTS.md", "/a/SOUL.md"],
    sessionFile: "/b/session.system-prompt.txt",
    sessionHash: "abc123",
  };

  it("returns all files resolved", () => {
    const set = resolveSemanticExpectedFiles(files);
    expect(set.has(path.resolve("/a/AGENTS.md"))).toBe(true);
    expect(set.has(path.resolve("/a/SOUL.md"))).toBe(true);
    expect(set.has(path.resolve("/b/session.system-prompt.txt"))).toBe(true);
  });

  it("has correct size", () => {
    const set = resolveSemanticExpectedFiles(files);
    expect(set.size).toBe(files.contextFiles.length + 1);
  });
});
