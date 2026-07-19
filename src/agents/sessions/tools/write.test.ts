// Write tool tests cover session path resolution and post-write recovery when
// remote or sandbox operations fail after persisting content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDiffString, generateUnifiedPatch } from "./edit-diff.js";
import { createWriteTool, type WriteOperations } from "./write.js";

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

  function createRecoverableOperations(
    writeFile: WriteOperations["writeFile"],
    appendFile?: NonNullable<WriteOperations["appendFile"]>,
  ): WriteOperations {
    return {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile,
      ...(appendFile ? { appendFile } : {}),
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

  it("returns terminal no-op when writing identical content to existing file", async () => {
    const filePath = await createTempPath("identical.txt");
    await fs.writeFile(filePath, "hello\n", "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "identical.txt", content: "hello\n" },
      undefined,
    );

    const tc0 = expectDefined(result.content[0], "result.content[0] test invariant");
    expect("text" in tc0 ? tc0.text : "").toContain("No changes made");
    expect((result as { terminate?: boolean }).terminate).toBe(true);
    expect(result.details).toEqual({ changed: false });
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("hello\n");
  });

  it("reports a created file with its authoritative diff", async () => {
    await createTempPath("created.txt");
    const content = "first\nsecond\n";
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "created.txt", content }, undefined);
    const diffResult = generateDiffString("", content);

    expect(result.details).toEqual({
      changed: true,
      created: true,
      diff: diffResult.diff,
      patch: generateUnifiedPatch("created.txt", "", content),
      firstChangedLine: diffResult.firstChangedLine,
    });
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
    const diffResult = generateDiffString(oldContent, content);

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to different.txt`,
    });
    expect(result.details).toEqual({
      changed: true,
      created: false,
      diff: diffResult.diff,
      patch: generateUnifiedPatch("different.txt", oldContent, content),
      firstChangedLine: diffResult.firstChangedLine,
    });
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(content);
  });

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
    let readCalled = false;
    const operations = createRecoverableOperations((absolutePath, content) =>
      fs.writeFile(absolutePath, content, "utf-8"),
    );
    operations.readFile = async () => {
      readCalled = true;
      throw new Error("oversized pre-write read");
    };
    const tool = createWriteTool(tmpDir, { operations });

    const result = await tool.execute(
      "call-1",
      { path: "large.txt", content: "replacement\n" },
      undefined,
    );

    expect(readCalled).toBe(false);
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

  it("does not guess creation status when the pre-write stat is unavailable", async () => {
    await createTempPath("unknown.txt");
    const operations: WriteOperations = {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
      statFile: async () => {
        throw new Error("remote stat unavailable");
      },
    };
    const tool = createWriteTool(tmpDir, { operations });

    const result = await tool.execute(
      "call-1",
      { path: "unknown.txt", content: "new\n" },
      undefined,
    );

    expect(result.details).toEqual({ changed: true });
  });

  it("appends natively without overwrite prechecks or duplicate-content suppression", async () => {
    const filePath = await createTempPath("append.txt");
    await fs.writeFile(filePath, "same\n", "utf8");
    const statFile = vi.fn(async () => ({ type: "file" as const, size: 5, mtimeMs: 1 }));
    const readFile = vi.fn(async () => Buffer.from("same\n"));
    const appendFile = vi.fn(async (absolutePath: string, content: string) => {
      await fs.appendFile(absolutePath, content, "utf8");
    });
    const tool = createWriteTool(tmpDir, {
      operations: {
        mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
        writeFile: async () => {},
        appendFile,
        readFile,
        statFile,
      },
    });

    const result = await tool.execute(
      "call-append",
      { path: filePath, content: "same\n", append: true },
      undefined,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully appended 5 bytes to ${filePath}`,
    });
    expect(result.details).toEqual({ changed: true });
    expect(statFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(appendFile).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("same\nsame\n");
  });

  it("creates a missing file in append mode", async () => {
    const filePath = await createTempPath("nested/new.txt");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-append-create",
      { path: filePath, content: "first\n", append: true },
      undefined,
    );

    expect(result.details).toEqual({ changed: true });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("first\n");
  });

  it("rejects an empty append instead of reporting a fabricated change", async () => {
    const filePath = await createTempPath("empty-append.txt");
    await fs.writeFile(filePath, "seed\n", "utf8");
    const appendFile = vi.fn(async () => {});
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {}, appendFile),
    });

    await expect(
      tool.execute("call-empty-append", { path: filePath, content: "", append: true }, undefined),
    ).rejects.toThrow("Append content must not be empty");
    expect(appendFile).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("seed\n");
  });

  it("hides and rejects append when an injected backend lacks native support", async () => {
    const filePath = await createTempPath("unsupported/append.txt");
    const mkdir = vi.fn(async () => {});
    const tool = createWriteTool(tmpDir, {
      operations: { mkdir, writeFile: async () => {} },
    });

    await expect(
      tool.execute(
        "call-append-unsupported",
        { path: filePath, content: "extra\n", append: true },
        undefined,
      ),
    ).rejects.toThrow("Append mode is not supported");
    expect(mkdir).not.toHaveBeenCalled();
    expect(
      (tool as unknown as { parameters: { properties: Record<string, unknown> } }).parameters
        .properties,
    ).not.toHaveProperty("append");
  });

  it("keeps append success authoritative when cancellation follows acknowledgement", async () => {
    const filePath = await createTempPath("append-abort.txt");
    await fs.writeFile(filePath, "seed\n", "utf8");
    const controller = new AbortController();
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(
        async () => {},
        async (absolutePath, content) => {
          await fs.appendFile(absolutePath, content, "utf8");
          controller.abort();
        },
      ),
    });

    const result = await tool.execute(
      "call-append-abort",
      { path: filePath, content: "more\n", append: true },
      controller.signal,
    );

    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Successfully appended",
    );
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("seed\nmore\n");
  });

  it("reports an uncertain outcome after append dispatch fails", async () => {
    const filePath = await createTempPath("append-uncertain.txt");
    await fs.writeFile(filePath, "seed\n", "utf8");
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(
        async () => {},
        async (absolutePath, content) => {
          await fs.appendFile(absolutePath, content, "utf8");
          throw new Error("remote append timed out");
        },
      ),
    });

    await expect(
      tool.execute(
        "call-append-uncertain",
        { path: filePath, content: "more\n", append: true },
        undefined,
      ),
    ).rejects.toThrow(/Append outcome is uncertain; do not retry automatically/);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("seed\nmore\n");
  });

  it("keeps cancellation before append dispatch as a definite abort", async () => {
    const filePath = await createTempPath("append-prestart.txt");
    await fs.writeFile(filePath, "seed\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    const appendFile = vi.fn(async () => {});
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {}, appendFile),
    });

    await expect(
      tool.execute(
        "call-append-prestart",
        { path: filePath, content: "more\n", append: true },
        controller.signal,
      ),
    ).rejects.toThrow(/^Operation aborted$/);
    expect(appendFile).not.toHaveBeenCalled();
  });
});
