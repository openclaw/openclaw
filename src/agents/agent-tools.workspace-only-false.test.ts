/**
 * Tests filesystem tools when workspaceOnly is disabled.
 * Confirms host read/write/edit and memory append wrappers allow intended
 * outside-workspace paths.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createReadTool } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/llm", async () => {
  const original =
    await vi.importActual<typeof import("openclaw/plugin-sdk/llm")>("openclaw/plugin-sdk/llm");
  return {
    ...original,
  };
});

import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolWorkspaceRootGuard,
  wrapToolWriteWithAppend,
} from "./agent-tools.read.js";
import { createWriteTool } from "./sessions/tools/write.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("FS tools with workspaceOnly=false", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let outsideFile: string;

  const hasToolError = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.some((content) => {
      if (content.type !== "text") {
        return false;
      }
      return content.text?.toLowerCase().includes("error") ?? false;
    });

  const toolsFor = (workspaceOnly: boolean | undefined): AnyAgentTool[] => {
    const read = createOpenClawReadTool(createReadTool(workspaceDir) as unknown as AnyAgentTool);
    const write = createHostWorkspaceWriteTool(workspaceDir, { workspaceOnly });
    const edit = createHostWorkspaceEditTool(workspaceDir, { workspaceOnly });
    const tools = [read, write, edit];
    return workspaceOnly
      ? tools.map((tool) => wrapToolWorkspaceRootGuard(tool, workspaceDir))
      : tools;
  };

  const requireTool = (tools: AnyAgentTool[], toolName: "write" | "edit" | "read") => {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`expected ${toolName} tool`);
    }
    return tool;
  };

  const runFsTool = async (
    toolName: "write" | "edit" | "read",
    callId: string,
    input: Record<string, unknown>,
    workspaceOnly: boolean | undefined,
  ) => {
    const tool = requireTool(toolsFor(workspaceOnly), toolName);
    const result = await tool.execute(callId, input);
    expect(hasToolError(result)).toBe(false);
    return result;
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir);
    outsideFile = path.join(tmpDir, "outside.txt");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should allow write outside workspace when workspaceOnly=false", async () => {
    await runFsTool(
      "write",
      "test-call-1",
      {
        path: outsideFile,
        content: "test content",
      },
      false,
    );
    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("test content");
  });

  it("should allow write outside workspace via ../ path when workspaceOnly=false", async () => {
    const relativeOutsidePath = path.join("..", "outside-relative-write.txt");
    const outsideRelativeFile = path.join(tmpDir, "outside-relative-write.txt");

    await runFsTool(
      "write",
      "test-call-1b",
      {
        path: relativeOutsidePath,
        content: "relative test content",
      },
      false,
    );
    const content = await fs.readFile(outsideRelativeFile, "utf-8");
    expect(content).toBe("relative test content");
  });

  it("should allow edit outside workspace when workspaceOnly=false", async () => {
    await fs.writeFile(outsideFile, "old content");

    await runFsTool(
      "edit",
      "test-call-2",
      {
        path: outsideFile,
        edits: [{ oldText: "old content", newText: "new content" }],
      },
      false,
    );
    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("new content");
  });

  it("should allow edit outside workspace via ../ path when workspaceOnly=false", async () => {
    const relativeOutsidePath = path.join("..", "outside-relative-edit.txt");
    const outsideRelativeFile = path.join(tmpDir, "outside-relative-edit.txt");
    await fs.writeFile(outsideRelativeFile, "old relative content");

    await runFsTool(
      "edit",
      "test-call-2b",
      {
        path: relativeOutsidePath,
        edits: [{ oldText: "old relative content", newText: "new relative content" }],
      },
      false,
    );
    const content = await fs.readFile(outsideRelativeFile, "utf-8");
    expect(content).toBe("new relative content");
  });

  it("should allow read outside workspace when workspaceOnly=false", async () => {
    await fs.writeFile(outsideFile, "test read content");

    const result = await runFsTool(
      "read",
      "test-call-3",
      {
        path: outsideFile,
      },
      false,
    );
    expect(JSON.stringify(result.content)).toContain("test read content");
  });

  it("returns optional not-found context for missing date-only daily memory reads", async () => {
    const result = await runFsTool(
      "read",
      "test-call-missing-daily-memory",
      {
        path: "memory/2026-05-15.md",
      },
      undefined,
    );
    expect(result).toStrictEqual({
      content: [
        {
          type: "text",
          text: "No daily memory file exists yet at memory/2026-05-15.md.",
        },
      ],
      details: {
        status: "not_found",
        path: "memory/2026-05-15.md",
        optional: true,
      },
    });
  });

  it("still throws for ordinary missing read paths", async () => {
    const readTool = requireTool(toolsFor(undefined), "read");

    await expect(
      readTool.execute("test-call-missing-ordinary-file", {
        path: "notes/missing.md",
      }),
    ).rejects.toThrow(/ENOENT|no such file|not found/i);
  });

  it("should allow write outside workspace when workspaceOnly is unset", async () => {
    const outsideUnsetFile = path.join(tmpDir, "outside-unset-write.txt");
    await runFsTool(
      "write",
      "test-call-3a",
      {
        path: outsideUnsetFile,
        content: "unset write content",
      },
      undefined,
    );
    const content = await fs.readFile(outsideUnsetFile, "utf-8");
    expect(content).toBe("unset write content");
  });

  it("should allow edit outside workspace when workspaceOnly is unset", async () => {
    const outsideUnsetFile = path.join(tmpDir, "outside-unset-edit.txt");
    await fs.writeFile(outsideUnsetFile, "before");
    await runFsTool(
      "edit",
      "test-call-3b",
      {
        path: outsideUnsetFile,
        edits: [{ oldText: "before", newText: "after" }],
      },
      undefined,
    );
    const content = await fs.readFile(outsideUnsetFile, "utf-8");
    expect(content).toBe("after");
  });

  it("should block write outside workspace when workspaceOnly=true", async () => {
    const tools = toolsFor(true);
    const writeTool = requireTool(tools, "write");

    // When workspaceOnly=true, the guard throws an error
    await expect(
      writeTool.execute("test-call-4", {
        path: outsideFile,
        content: "test content",
      }),
    ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
  });

  it("should append to an existing file when append=true (workspaceOnly=false)", async () => {
    await fs.writeFile(outsideFile, "line one\n");

    const tools = toolsFor(false);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    const result = await writeTool!.execute("test-append-1", {
      path: outsideFile,
      content: "line two\n",
      append: true,
    });
    expect(hasToolError(result)).toBe(false);
    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("line one\nline two\n");
  });

  it("should create a new file when append=true and file does not exist (workspaceOnly=false)", async () => {
    const newFile = path.join(tmpDir, "append-new.txt");

    const tools = toolsFor(false);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    await writeTool!.execute("test-append-2", {
      path: newFile,
      content: "first line\n",
      append: true,
    });
    const content = await fs.readFile(newFile, "utf-8");
    expect(content).toBe("first line\n");
  });

  it("normalizes file URL paths before appending (workspaceOnly=false)", async () => {
    await fs.writeFile(outsideFile, "line one\n");

    const tools = toolsFor(false);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    await writeTool!.execute("test-append-file-url", {
      path: pathToFileURL(outsideFile).href,
      content: "line two\n",
      append: true,
    });

    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("line one\nline two\n");
  });

  it("strips malformed XML arg-value suffixes before appending", async () => {
    await fs.writeFile(outsideFile, "line one\n");

    const tools = toolsFor(false);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    const result = await writeTool!.execute("test-append-malformed-suffix", {
      path: `${outsideFile}</arg_value>>`,
      content: "line two\n",
      append: true,
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Successfully appended"),
    });
    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("line one\nline two\n");
  });

  it("should overwrite (not append) when append=false", async () => {
    await fs.writeFile(outsideFile, "old content");

    const tools = toolsFor(false);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    await writeTool!.execute("test-no-append", {
      path: outsideFile,
      content: "new content",
      append: false,
    });
    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("new content");
  });

  it("rejects malformed append values before falling back to overwrite", async () => {
    await fs.writeFile(outsideFile, "old content");

    const tools = toolsFor(false);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    await expect(
      writeTool!.execute("test-invalid-append", {
        path: outsideFile,
        content: "new content",
        append: "true",
      }),
    ).rejects.toThrow(/append parameter.*boolean/);

    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("old content");
  });

  it("should append within workspace boundary when append=true and workspaceOnly=true", async () => {
    const insideFile = path.join(workspaceDir, "log.txt");
    await fs.writeFile(insideFile, "entry 1\n");

    const tools = toolsFor(true);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    const result = await writeTool!.execute("test-append-workspace", {
      path: insideFile,
      content: "entry 2\n",
      append: true,
    });
    expect(hasToolError(result)).toBe(false);
    const content = await fs.readFile(insideFile, "utf-8");
    expect(content).toBe("entry 1\nentry 2\n");
  });

  it("routes wrapper append calls through the shared write recovery path", async () => {
    const filePath = path.join(tmpDir, "wrapped-append-recovery.txt");
    await fs.writeFile(filePath, "before\n", "utf-8");
    const appendFile = vi.fn(async (absolutePath: string, content: string) => {
      await fs.appendFile(absolutePath, content, "utf-8");
      throw new Error("node invoke timed out");
    });
    const baseTool = createWriteTool(tmpDir, {
      operations: {
        mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
        writeFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
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
      },
    }) as unknown as AnyAgentTool;
    const writeTool = wrapToolWriteWithAppend(baseTool);

    const result = await writeTool.execute("wrapped-append", {
      path: filePath,
      content: "after\n",
      append: true,
    });

    expect(appendFile).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("before\nafter\n");
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully appended ${"after\n".length} bytes to ${filePath}`,
    });
  });

  it("restricts memory-triggered writes to append-only canonical memory files", async () => {
    const allowedRelativePath = "memory/2026-03-07.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed");

    const tools = [
      wrapToolMemoryFlushAppendOnlyWrite(createHostWorkspaceWriteTool(workspaceDir), {
        root: workspaceDir,
        relativePath: allowedRelativePath,
      }),
    ];

    const writeTool = requireTool(tools, "write");
    expect(tools.map((tool) => tool.name)).toEqual(["write"]);

    await expect(
      writeTool.execute("test-call-memory-deny", {
        path: outsideFile,
        content: "should not write here",
      }),
    ).rejects.toThrow(/Memory flush writes are restricted to memory\/2026-03-07\.md/);

    const result = await writeTool.execute("test-call-memory-append", {
      path: allowedRelativePath,
      content: "new note",
    });
    expect(hasToolError(result)).toBe(false);
    expect(result).toStrictEqual({
      content: [{ type: "text", text: "Appended content to memory/2026-03-07.md." }],
      details: {
        path: "memory/2026-03-07.md",
        appendOnly: true,
      },
    });
    await expect(fs.readFile(allowedAbsolutePath, "utf-8")).resolves.toBe("seed\nnew note");
  });

  it("accepts memory-triggered append-only writes with malformed XML arg-value path suffixes", async () => {
    const allowedRelativePath = "memory/2026-03-08.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);

    const writeTool = wrapToolMemoryFlushAppendOnlyWrite(
      createHostWorkspaceWriteTool(workspaceDir),
      {
        root: workspaceDir,
        relativePath: allowedRelativePath,
      },
    );

    const result = await writeTool.execute("test-call-memory-suffix", {
      path: `${allowedRelativePath}</arg_value>>`,
      content: "new note",
    });

    expect(hasToolError(result)).toBe(false);
    expect(result).toStrictEqual({
      content: [{ type: "text", text: "Appended content to memory/2026-03-08.md." }],
      details: {
        path: "memory/2026-03-08.md",
        appendOnly: true,
      },
    });
    await expect(fs.readFile(allowedAbsolutePath, "utf-8")).resolves.toBe("new note");
  });

  it("rejects memory-triggered append-only paths that become empty after suffix stripping", async () => {
    const writeTool = wrapToolMemoryFlushAppendOnlyWrite(
      createHostWorkspaceWriteTool(workspaceDir),
      {
        root: workspaceDir,
        relativePath: "memory/2026-03-09.md",
      },
    );

    await expect(
      writeTool.execute("test-call-memory-empty-suffix", {
        path: "</arg_value>>",
        content: "new note",
      }),
    ).rejects.toThrow(/Missing required parameter: path/);
  });
});
