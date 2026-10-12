// Write tool tests cover session path resolution and post-write recovery when
// remote or sandbox operations fail after persisting content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatch } from "diff";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { WriteToolOutputSchema } from "./tool-schemas.js";
import { createWriteTool, type WriteToolOptions } from "./write.js";

type WriteOperations = NonNullable<WriteToolOptions["operations"]>;

const WritePatchReceiptSchema = Type.Extract(
  WriteToolOutputSchema,
  Type.Object({ patch: Type.String() }),
);

function expectApplicablePatch(details: unknown, oldContent: string, content: string) {
  if (!Value.Check(WritePatchReceiptSchema, details)) {
    throw new Error("Expected a changed-file receipt with a patch");
  }
  expect(applyPatch(oldContent, details.patch)).toBe(content);
}

describe("write tool", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function createTempPath(name = "demo.txt") {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-tool-"));
    return path.join(tmpDir, name);
  }

  function createRecoverableOperations(writeFile: WriteOperations["writeFile"]): WriteOperations {
    return {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile,
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: async (absolutePath) => {
        try {
          const stat = await fs.stat(absolutePath);
          return {
            type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          } as const;
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: unknown }).code === "ENOENT"
          ) {
            return null;
          }
          throw error;
        }
      },
    };
  }

  it("recovers success after a post-write abort when readback matches requested content", async () => {
    // Remote transports can report cancellation after the write landed; verify
    // by readback before surfacing a false failure to the model.
    const filePath = await createTempPath();
    const expectedContent = "finished 😀\n";
    const controller = new AbortController();
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async (absolutePath, content) => {
        await fs.writeFile(absolutePath, content, "utf-8");
        controller.abort();
        throw new Error("Operation aborted");
      }),
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: expectedContent },
      controller.signal,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${Buffer.byteLength(expectedContent, "utf8")} bytes to ${filePath}`,
    });
  });

  it("keeps the original abort when the file already matched before execution", async () => {
    // Matching pre-existing content is not proof this call wrote successfully.
    const filePath = await createTempPath();
    await fs.writeFile(filePath, "finished\n", "utf-8");
    const controller = new AbortController();
    controller.abort();
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {
        throw new Error("Operation aborted");
      }),
    });

    await expect(
      tool.execute("call-1", { path: filePath, content: "finished\n" }, controller.signal),
    ).rejects.toThrow("Operation aborted");
  });

  it("rejects a delegated write that leaves stale same-size invalid UTF-8 bytes", async () => {
    const original = Buffer.from([0xf0, 0x90, 0x80]);
    const content = "\uFFFD";
    const filePath = await createTempPath("stale.txt");
    await fs.writeFile(filePath, original);
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {}),
    });

    await expect(tool.execute("call-1", { path: filePath, content }, undefined)).rejects.toThrow(
      "Write verification failed",
    );
    await expect(fs.readFile(filePath)).resolves.toEqual(original);
  });

  it("rejects a delegated write that leaves a non-file target", async () => {
    const filePath = await createTempPath("directory");
    await fs.mkdir(filePath);
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {}),
    });

    await expect(
      tool.execute("call-1", { path: filePath, content: "expected\n" }, undefined),
    ).rejects.toThrow("Write verification failed");
  });

  it("verifies delegated UTF-8 bytes with text readback", async () => {
    const filePath = await createTempPath("surrogate.txt");
    const content = "unpaired \ud800 surrogate\n";
    const operations = createRecoverableOperations((absolutePath, requestedContent) =>
      fs.writeFile(absolutePath, requestedContent, "utf-8"),
    );
    operations.readFile = (absolutePath) => fs.readFile(absolutePath, "utf8");
    const tool = createWriteTool(tmpDir, { operations });

    await expect(
      tool.execute("call-1", { path: filePath, content }, undefined),
    ).resolves.toMatchObject({ details: { changed: true, created: true } });
    await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
    const noOpResult = await tool.execute("call-2", { path: filePath, content }, undefined);
    expect(noOpResult).toMatchObject({ details: { changed: false } });
    expect((noOpResult as { terminate?: boolean }).terminate).toBeUndefined();
    expect(noOpResult.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("No changes made"),
    });
  });

  it("writes the literal Unicode-space path instead of an ASCII-space sibling", async () => {
    const nnbspPath = await createTempPath("report 2026.md");
    const asciiPath = path.join(tmpDir, "report 2026.md");
    await fs.writeFile(asciiPath, "ascii\n", "utf-8");
    const tool = createWriteTool(tmpDir);

    await tool.execute("call-1", { path: nnbspPath, content: "nnbsp\n" }, undefined);

    await expect(fs.readFile(nnbspPath, "utf-8")).resolves.toBe("nnbsp\n");
    await expect(fs.readFile(asciiPath, "utf-8")).resolves.toBe("ascii\n");
  });

  it("keeps oversized created-file details bounded", async () => {
    await createTempPath("large-created.txt");
    const content = "x".repeat(1024 * 1024 + 1);
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "large-created.txt", content }, undefined);

    expect(result.details).toEqual({ changed: true, created: true });
  });

  it("reports an overwrite with the readable old-content diff", async () => {
    const filePath = await createTempPath("different.txt");
    const content = "new 😀\n";
    const oldContent = "old\n";
    await fs.writeFile(filePath, oldContent, "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "different.txt", content }, undefined);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to different.txt`,
    });
    expect(result.details).toEqual({
      changed: true,
      created: false,
      diff: "-1 old\n+1 new 😀",
      patch: expect.stringContaining("--- different.txt\n+++ different.txt\n"),
      firstChangedLine: 1,
    });
    expectApplicablePatch(result.details, oldContent, content);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(content);
  });

  it("preserves both receipt formats for distant hunks", async () => {
    const middle = Array.from({ length: 9 }, (_, i) => `context-${i}\n`).join("");
    const oldContent = `before\n${middle}after\n`;
    const content = `BEFORE\n${middle}AFTER\n`;
    const filePath = await createTempPath("receipt.txt");
    await fs.writeFile(filePath, oldContent, "utf8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "receipt.txt", content }, undefined);
    expect(result.details).toEqual({
      changed: true,
      created: false,
      diff: expect.stringContaining("- 1 before\n+ 1 BEFORE"),
      patch: expect.stringContaining("--- receipt.txt\n+++ receipt.txt\n"),
      firstChangedLine: 1,
    });
    expectApplicablePatch(result.details, oldContent, content);
    await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
  });

  it("keeps oversized overwrite details bounded", async () => {
    const filePath = await createTempPath("large-replacement.txt");
    await fs.writeFile(filePath, "old\n", "utf-8");
    const content = "x".repeat(1024 * 1024 + 1);
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "large-replacement.txt", content },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("rejects success when the post-write stat is unavailable", async () => {
    await createTempPath("unknown.txt");
    const operations: WriteOperations = {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: async () => {
        throw new Error("remote stat unavailable");
      },
    };
    const tool = createWriteTool(tmpDir, { operations });

    await expect(
      tool.execute("call-1", { path: "unknown.txt", content: "new\n" }, undefined),
    ).rejects.toThrow("Write verification failed");
  });
});
