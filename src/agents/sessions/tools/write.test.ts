// Write tool tests cover session path resolution and post-write recovery when
// remote or sandbox operations fail after persisting content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createWriteTool, createWriteToolDefinition, type WriteOperations } from "./write.js";

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
    appendFile: WriteOperations["appendFile"] = (absolutePath, content) =>
      fs.appendFile(absolutePath, content, "utf-8"),
  ): WriteOperations {
    return {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile,
      appendFile,
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
      { path: filePath, content: "finished\n" },
      controller.signal,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${"finished\n".length} bytes to ${filePath}`,
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

  it("advertises append mode in shared write prompt metadata", () => {
    const definition = createWriteToolDefinition(tmpDir);

    expect(definition.description).toContain("appends when append is true");
    expect(definition.promptSnippet).toContain("append");
    expect((definition.promptGuidelines ?? []).join("\n")).toContain("append: true");
  });

  it("appends content when append mode is enabled", async () => {
    const filePath = await createTempPath("append.txt");
    await fs.writeFile(filePath, "alpha\n", "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: "beta\n", append: true },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha\nbeta\n");
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully appended ${"beta\n".length} bytes to ${filePath}`,
    });
  });

  it.each(["false", 1])("rejects malformed append values before branching", async (append) => {
    const filePath = await createTempPath(`append-invalid-${String(append)}.txt`);
    await fs.writeFile(filePath, "alpha\n", "utf-8");
    const tool = createWriteTool(tmpDir);

    await expect(
      tool.execute(
        "call-1",
        { path: filePath, content: "beta\n", append } as never,
        undefined,
      ),
    ).rejects.toThrow(/append parameter.*boolean/);

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha\n");
  });

  it("recovers timeout-like post-append errors when readback preserves existing content", async () => {
    const filePath = await createTempPath("append-timeout.txt");
    await fs.writeFile(filePath, "alpha\n", "utf-8");
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(
        (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
        async (absolutePath, content) => {
          await fs.appendFile(absolutePath, content, "utf-8");
          throw new Error("node invoke timed out");
        },
      ),
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: "beta\n", append: true },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha\nbeta\n");
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully appended ${"beta\n".length} bytes to ${filePath}`,
    });
  });

  it("reports success when append completes before an abort is observed", async () => {
    const filePath = await createTempPath("append-abort.txt");
    await fs.writeFile(filePath, "alpha\n", "utf-8");
    const controller = new AbortController();
    const tool = createWriteTool(tmpDir, {
      operations: {
        mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
        writeFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
        appendFile: async (absolutePath, content) => {
          await fs.appendFile(absolutePath, content, "utf-8");
          controller.abort();
        },
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: "beta\n", append: true },
      controller.signal,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha\nbeta\n");
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully appended ${"beta\n".length} bytes to ${filePath}`,
    });
  });

  it("rejects append mode when the backend does not support appending", async () => {
    const filePath = await createTempPath("append-unsupported.txt");
    const tool = createWriteTool(tmpDir, {
      operations: {
        mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
        writeFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
      },
    });

    await expect(
      tool.execute("call-1", { path: filePath, content: "beta\n", append: true }, undefined),
    ).rejects.toThrow("Append mode is not supported by this write tool backend");
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

    const tc0 = result.content[0];
    expect("text" in tc0 ? tc0.text : "").toContain("No changes made");
    expect((result as any).terminate).toBe(true);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("hello\n");
  });

  it("writes different content successfully (no false positive for no-op)", async () => {
    const filePath = await createTempPath("different.txt");
    await fs.writeFile(filePath, "old\n", "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "different.txt", content: "new\n" },
      undefined,
    );

    const tc1 = result.content[0];
    expect("text" in tc1 ? tc1.text : "").toContain("Successfully wrote");
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("new\n");
  });
});
