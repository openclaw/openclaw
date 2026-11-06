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
import { hasErrnoCode } from "../../../infra/errno.js";
import { readPersistedFileStat } from "./file-write-verification.js";
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
  let tool: ReturnType<typeof createWriteTool>;

  function write(filePath: string, content: string, signal?: AbortSignal) {
    return tool.execute("call-1", { path: filePath, content }, signal);
  }

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function createTempPath(name = "demo.txt", original?: string | Buffer) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-tool-"));
    tool = createWriteTool(tmpDir);
    const filePath = path.join(tmpDir, name);
    if (original !== undefined) {
      await fs.writeFile(filePath, original);
    }
    return filePath;
  }

  function createRecoverableOperations(writeFile: WriteOperations["writeFile"]): WriteOperations {
    return {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile,
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: (absolutePath) =>
        readPersistedFileStat(absolutePath, (error) => hasErrnoCode(error, "ENOENT")),
    };
  }

  it.each(["abort", "timeout"])("recovers a persisted write after %s", async (failure) => {
    const filePath = await createTempPath();
    const content = "finished 😀\n";
    const controller = new AbortController();
    tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async (absolutePath, requested) => {
        await fs.writeFile(absolutePath, requested, "utf8");
        if (failure === "abort") {
          controller.abort();
        }
        throw new Error(failure === "abort" ? "Operation aborted" : "node invoke timed out");
      }),
    });
    const result = await write(filePath, content, controller.signal);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`,
    });
  });

  it("keeps the original abort when the file already matched before execution", async () => {
    // Matching pre-existing content is not proof this call wrote successfully.
    const filePath = await createTempPath(undefined, "finished\n");
    const controller = new AbortController();
    controller.abort();
    tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {
        throw new Error("Operation aborted");
      }),
    });

    await expect(write(filePath, "finished\n", controller.signal)).rejects.toThrow(
      "Operation aborted",
    );
  });

  it.each(["missing", "directory"])("rejects a delegated write to a %s target", async (target) => {
    const filePath = await createTempPath();
    if (target === "directory") {
      await fs.mkdir(filePath);
    }
    tool = createWriteTool(tmpDir, { operations: createRecoverableOperations(async () => {}) });
    await expect(write(filePath, "expected\n")).rejects.toThrow("Write verification failed");
    if (target === "missing") {
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    { name: "text", original: Buffer.from("stale\n"), content: "fresh\n" },
    { name: "invalid UTF-8", original: Buffer.from([0xf0, 0x90, 0x80]), content: "\uFFFD" },
  ])(
    "rejects a delegated write that leaves stale same-size bytes: $name",
    async ({ original, content }) => {
      const filePath = await createTempPath("stale.txt", original);
      tool = createWriteTool(tmpDir, {
        operations: createRecoverableOperations(async () => {}),
      });

      await expect(write(filePath, content)).rejects.toThrow("Write verification failed");
      await expect(fs.readFile(filePath)).resolves.toEqual(original);
    },
  );

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
      tool = createWriteTool(tmpDir, { operations });

      await expect(write(filePath, content)).resolves.toMatchObject({
        details: { changed: true, created: true },
      });
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
      const noOpResult = await tool.execute("call-2", { path: filePath, content }, undefined);
      expect(noOpResult).toMatchObject({ details: { changed: false } });
      expect((noOpResult as { terminate?: boolean }).terminate).toBeUndefined();
    },
  );

  it("overwrites invalid UTF-8 bytes that decode to the requested text", async () => {
    const filePath = await createTempPath("invalid.txt", Buffer.from([0xf0, 0x90, 0x80]));

    await expect(write(filePath, "\uFFFD")).resolves.toMatchObject({
      details: { changed: true, created: false },
    });
    await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from("\uFFFD", "utf8"));
  });

  it("writes file URL paths through the shared session path resolver", async () => {
    const filePath = await createTempPath("notes.md");

    await write(pathToFileURL(filePath).href, "finished\n");

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("finished\n");
  });

  it("writes the literal Unicode-space path instead of an ASCII-space sibling", async () => {
    const nnbspPath = await createTempPath("report 2026.md");
    const asciiPath = path.join(tmpDir, "report 2026.md");
    await fs.writeFile(asciiPath, "ascii\n", "utf-8");

    await write(nnbspPath, "nnbsp\n");

    await expect(fs.readFile(nnbspPath, "utf-8")).resolves.toBe("nnbsp\n");
    await expect(fs.readFile(asciiPath, "utf-8")).resolves.toBe("ascii\n");
  });

  it.each(["café 🦀\r\n日本語 e\u0301\r\n", "\uFFFD\r\n"])(
    "returns a non-terminal no-op for identical UTF-8 content: %j",
    async (content) => {
      const filePath = await createTempPath("identical.txt", content);

      const result = await write("identical.txt", content);

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

    const result = await write("created.txt", content);
    expect(result.details).toEqual({
      changed: true,
      created: true,
      diff: "+1 first\n+2 second",
      patch: expect.stringContaining("--- created.txt\n+++ created.txt\n"),
      firstChangedLine: 1,
    });
    expectApplicablePatch(result.details, "", content);
  });

  it("reports an overwrite with the readable old-content diff", async () => {
    const filePath = await createTempPath("different.txt");
    const content = "new 😀\n";
    const oldContent = "old\n";
    await fs.writeFile(filePath, oldContent, "utf-8");

    const result = await write("different.txt", content);
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

  it.each<[string, string, string, number]>([
    ["a\nb\n", "first\na\nb\n", "+1 first\n 2 a\n 3 b", 1],
    ["a\nb\nlast\n", "a\nb\n", " 1 a\n 2 b\n-3 last", 3],
    ["last\n", "", "-1 last", 1],
    ["last\n", "last", "-1 last\n+1 last", 1],
    ["last", "last\n", "-1 last\n+1 last", 1],
    [
      "café 🦀\r\n日本語 e\u0301\r\nlast",
      "café 😀\r\n日本語 é\r\nlast",
      "-1 café 🦀\r\n-2 日本語 e\u0301\r\n+1 café 😀\r\n+2 日本語 é\r\n 3 last",
      1,
    ],
  ])(
    "preserves both receipt formats changing %j to %j",
    async (oldContent, content, diff, firstChangedLine) => {
      const filePath = await createTempPath("receipt.txt", oldContent);
      const result = await write("receipt.txt", content);
      expect(result.details).toEqual({
        changed: true,
        created: false,
        diff,
        firstChangedLine,
        patch: expect.stringContaining("--- receipt.txt\n+++ receipt.txt\n"),
      });
      expectApplicablePatch(result.details, oldContent, content);
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
    },
  );

  it.each([7, 8, 9])("preserves patch hunks across %i context lines", async (gap) => {
    const middle = Array.from({ length: gap }, (_, i) => `context-${i}\n`).join("");
    const oldContent = `before\n${middle}after\n`;
    const content = `BEFORE\n${middle}AFTER\n`;
    const filePath = await createTempPath("receipt.txt", oldContent);
    const result = await write("receipt.txt", content);
    expect(result.details).toEqual({
      changed: true,
      created: false,
      diff: expect.stringContaining("- 1 before\n+ 1 BEFORE"),
      firstChangedLine: 1,
      patch: expect.stringContaining("--- receipt.txt\n+++ receipt.txt\n"),
    });
    expectApplicablePatch(result.details, oldContent, content);
    await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(content, "utf8"));
  });

  it.each([1999, 2000, 2001])(
    "preserves the overwrite receipt budget at edit distance %i",
    async (editDistance) => {
      const filePath = await createTempPath("edit-limit.txt");
      const oldContent = "anchor\n";
      const content = oldContent + "added\n".repeat(editDistance);
      await fs.writeFile(filePath, oldContent, "utf8");

      const result = await write("edit-limit.txt", content);

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

  it.each<[string, string | Buffer | undefined, string]>([
    ["binary old content", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]), "text now\n"],
    ["large creation", undefined, "x".repeat(1024 * 1024 + 1)],
    ["many created lines", undefined, "a\n".repeat(25_000)],
    ["combined line count", "a\n".repeat(15_000), "b\n".repeat(15_000)],
    ["combined byte count", "a".repeat(600 * 1024), "b".repeat(600 * 1024)],
    ["large replacement", "old\n", "x".repeat(1024 * 1024 + 1)],
    [
      "distinct-line edit budget",
      Array.from({ length: 10_000 }, (_, i) => `old-${i}`).join("\n"),
      Array.from({ length: 10_000 }, (_, i) => `new-${i}`).join("\n"),
    ],
  ])("bounds receipts for %s", async (_name, original, content) => {
    const filePath = await createTempPath(undefined, original);
    const result = await write(filePath, content);
    expect(result.details).toEqual({ changed: true, created: original === undefined });
  });

  it("reports an overwrite without a fabricated diff when the old file is too large", async () => {
    await createTempPath("large.txt", "x".repeat(1024 * 1024 + 1));
    let readCount = 0;
    const operations = createRecoverableOperations((absolutePath, content) =>
      fs.writeFile(absolutePath, content, "utf-8"),
    );
    operations.readFile = async (absolutePath) => {
      readCount += 1;
      return fs.readFile(absolutePath);
    };
    tool = createWriteTool(tmpDir, { operations });

    const result = await write("large.txt", "replacement\n");

    expect(readCount).toBe(1);
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
    tool = createWriteTool(tmpDir, { operations });

    await expect(write("unknown.txt", "new\n")).rejects.toThrow("Write verification failed");
  });
});
