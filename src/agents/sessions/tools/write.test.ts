// Write tool tests cover session path resolution and post-write recovery when
// remote or sandbox operations fail after persisting content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { applyPatch } from "diff";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { WriteToolOutputSchema } from "./tool-schemas.js";
import { createWriteTool, type WriteOperations } from "./write.js";

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

  it("recovers timeout-like post-write errors when readback matches requested content", async () => {
    const filePath = await createTempPath();
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async (absolutePath, content) => {
        await fs.writeFile(absolutePath, content, "utf-8");
        throw new Error("node invoke timed out");
      }),
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: "finished\n" },
      undefined,
    );

    expect(result.content[0]?.type).toBe("text");
  });

  it("rejects a delegated write that resolves without creating the file", async () => {
    const filePath = await createTempPath("missing.txt");
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {}),
    });

    await expect(
      tool.execute("call-1", { path: filePath, content: "expected\n" }, undefined),
    ).rejects.toThrow("Write verification failed");
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "text", original: Buffer.from("stale\n"), content: "fresh\n" },
    { name: "invalid UTF-8", original: Buffer.from([0xf0, 0x90, 0x80]), content: "\uFFFD" },
  ])(
    "rejects a delegated write that leaves stale same-size bytes: $name",
    async ({ original, content }) => {
      const filePath = await createTempPath("stale.txt");
      await fs.writeFile(filePath, original);
      const tool = createWriteTool(tmpDir, {
        operations: createRecoverableOperations(async () => {}),
      });

      await expect(tool.execute("call-1", { path: filePath, content }, undefined)).rejects.toThrow(
        "Write verification failed",
      );
      await expect(fs.readFile(filePath)).resolves.toEqual(original);
    },
  );

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

  it.each(["buffer", "text"] as const)(
    "verifies delegated UTF-8 bytes with %s readback",
    async (readback) => {
      const filePath = await createTempPath("surrogate.txt");
      const content = "unpaired \ud800 surrogate\n";
      const operations = createRecoverableOperations((absolutePath, requestedContent) =>
        fs.writeFile(absolutePath, requestedContent, "utf-8"),
      );
      if (readback === "text") {
        operations.readFile = (absolutePath) => fs.readFile(absolutePath, "utf8");
      }
      const tool = createWriteTool(tmpDir, { operations });

      await expect(
        tool.execute("call-1", { path: filePath, content }, undefined),
      ).resolves.toMatchObject({ details: { changed: true, created: true } });
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
      const noOpResult = await tool.execute("call-2", { path: filePath, content }, undefined);
      expect(noOpResult).toMatchObject({ details: { changed: false } });
      expect((noOpResult as { terminate?: boolean }).terminate).toBeUndefined();
    },
  );

  it("overwrites invalid UTF-8 bytes that decode to the requested text", async () => {
    const filePath = await createTempPath("invalid.txt");
    await fs.writeFile(filePath, Buffer.from([0xf0, 0x90, 0x80]));
    const tool = createWriteTool(tmpDir);

    await expect(
      tool.execute("call-1", { path: filePath, content: "\uFFFD" }, undefined),
    ).resolves.toMatchObject({ details: { changed: true, created: false } });
    await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from("\uFFFD", "utf8"));
  });

  it("writes file URL paths through the shared session path resolver", async () => {
    const filePath = await createTempPath("notes.md");
    const tool = createWriteTool(tmpDir);

    await tool.execute(
      "call-1",
      { path: pathToFileURL(filePath).href, content: "finished\n" },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("finished\n");
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

  it.each(["café 🦀\r\n日本語 e\u0301\r\n", "\uFFFD\r\n"])(
    "returns a non-terminal no-op for identical UTF-8 content: %j",
    async (content) => {
      const filePath = await createTempPath("identical.txt");
      await fs.writeFile(filePath, content, "utf-8");
      const tool = createWriteTool(tmpDir);

      const result = await tool.execute("call-1", { path: "identical.txt", content }, undefined);

      const tc0 = expectDefined(result.content[0], "result.content[0] test invariant");
      expect("text" in tc0 ? tc0.text : "").toContain("No changes made");
      expect((result as { terminate?: boolean }).terminate).toBeUndefined();
      expect(result.details).toEqual({ changed: false });
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
    },
  );

  it("reports a created file with its authoritative diff", async () => {
    await createTempPath("created.txt");
    const content = "first\nsecond\n";
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "created.txt", content }, undefined);
    expect(result.details).toEqual({
      changed: true,
      created: true,
      diff: "+1 first\n+2 second",
      patch: expect.stringContaining("--- created.txt\n+++ created.txt\n"),
      firstChangedLine: 1,
    });
    expectApplicablePatch(result.details, "", content);
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

  it.each([
    {
      name: "insert at start",
      oldContent: "a\nb\n",
      content: "first\na\nb\n",
      diff: "+1 first\n 2 a\n 3 b",
      firstChangedLine: 1,
    },
    {
      name: "delete at end",
      oldContent: "a\nb\nlast\n",
      content: "a\nb\n",
      diff: " 1 a\n 2 b\n-3 last",
      firstChangedLine: 3,
    },
    {
      name: "empty overwrite",
      oldContent: "last\n",
      content: "",
      diff: "-1 last",
      firstChangedLine: 1,
    },
    {
      name: "remove final newline",
      oldContent: "last\n",
      content: "last",
      diff: "-1 last\n+1 last",
      firstChangedLine: 1,
    },
    {
      name: "add final newline",
      oldContent: "last",
      content: "last\n",
      diff: "-1 last\n+1 last",
      firstChangedLine: 1,
    },
    {
      name: "CRLF and Unicode without final newline",
      oldContent: "café 🦀\r\n日本語 e\u0301\r\nlast",
      content: "café 😀\r\n日本語 é\r\nlast",
      diff: "-1 café 🦀\r\n-2 日本語 e\u0301\r\n+1 café 😀\r\n+2 日本語 é\r\n 3 last",
      firstChangedLine: 1,
    },
    ...[7, 8, 9].map((gap) => {
      const middle = Array.from({ length: gap }, (_, i) => `context-${i}\n`).join("");
      return {
        name: `${gap} context lines between edits`,
        oldContent: `before\n${middle}after\n`,
        content: `BEFORE\n${middle}AFTER\n`,
        diff: expect.stringContaining("- 1 before\n+ 1 BEFORE"),
        firstChangedLine: 1,
      };
    }),
  ])(
    "preserves both receipt formats for $name",
    async ({ oldContent, content, diff, firstChangedLine }) => {
      const filePath = await createTempPath("receipt.txt");
      await fs.writeFile(filePath, oldContent, "utf8");
      const tool = createWriteTool(tmpDir);

      const result = await tool.execute("call-1", { path: "receipt.txt", content }, undefined);
      expect(result.details).toEqual({
        changed: true,
        created: false,
        diff,
        patch: expect.stringContaining("--- receipt.txt\n+++ receipt.txt\n"),
        firstChangedLine,
      });
      expectApplicablePatch(result.details, oldContent, content);
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
    },
  );

  it.each([1999, 2000, 2001])(
    "preserves the overwrite receipt budget at edit distance %i",
    async (editDistance) => {
      const filePath = await createTempPath("edit-limit.txt");
      const oldContent = "anchor\n";
      const content = oldContent + "added\n".repeat(editDistance);
      await fs.writeFile(filePath, oldContent, "utf8");
      const tool = createWriteTool(tmpDir);

      const result = await tool.execute("call-1", { path: "edit-limit.txt", content }, undefined);

      if (editDistance <= 2000) {
        expect(result.details).toEqual({
          changed: true,
          created: false,
          diff: expect.stringContaining("    1 anchor\n+   2 added"),
          patch: expect.any(String),
          firstChangedLine: 2,
        });
        expectApplicablePatch(result.details, oldContent, content);
      } else {
        expect(result.details).toEqual({ changed: true, created: false });
      }
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
    },
  );

  it("omits the diff when the old content is not valid UTF-8 text", async () => {
    const filePath = await createTempPath("binary.bin");
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]));
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "binary.bin", content: "text now\n" },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("omits the diff when the rewrite's edit distance blows the budget", async () => {
    const filePath = await createTempPath("distinct-lines.txt");
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `old-${i}`).join("\n");
    await fs.writeFile(filePath, oldContent, "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      {
        path: "distinct-lines.txt",
        content: Array.from({ length: 10_000 }, (_, i) => `new-${i}`).join("\n"),
      },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("omits the diff for created files with excessive line counts", async () => {
    await createTempPath("many-lines-created.txt");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "many-lines-created.txt", content: "a\n".repeat(25_000) },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: true });
  });

  it("omits the diff when combined line counts exceed the diff budget", async () => {
    const filePath = await createTempPath("many-lines.txt");
    await fs.writeFile(filePath, "a\n".repeat(15_000), "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "many-lines.txt", content: "b\n".repeat(15_000) },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("omits the diff when combined old and new content exceeds the diff budget", async () => {
    const filePath = await createTempPath("combined.txt");
    await fs.writeFile(filePath, "a".repeat(600 * 1024), "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "combined.txt", content: "b".repeat(600 * 1024) },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("reports an overwrite without a fabricated diff when the old file is too large", async () => {
    const filePath = await createTempPath("large.txt");
    await fs.writeFile(filePath, "x".repeat(1024 * 1024 + 1), "utf-8");
    let readCount = 0;
    const operations = createRecoverableOperations((absolutePath, content) =>
      fs.writeFile(absolutePath, content, "utf-8"),
    );
    operations.readFile = async (absolutePath) => {
      readCount += 1;
      return fs.readFile(absolutePath);
    };
    const tool = createWriteTool(tmpDir, { operations });

    const result = await tool.execute(
      "call-1",
      { path: "large.txt", content: "replacement\n" },
      undefined,
    );

    expect(readCount).toBe(1);
    expect(result.details).toEqual({ changed: true, created: false });
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
