/**
 * Tests filesystem tools when workspaceOnly is disabled.
 * Confirms host read/write/edit and memory append wrappers allow intended
 * outside-workspace paths.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
} from "./agent-tools.read.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
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

  it("should allow append outside workspace when workspaceOnly=false", async () => {
    await fs.writeFile(outsideFile, "seed", "utf8");
    await runFsTool(
      "write",
      "test-call-append-outside",
      {
        path: outsideFile,
        content: "+next",
        append: true,
      },
      false,
    );
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("seed+next");
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
        kind: "not_found",
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

  it("should append inside workspace and block outside append when workspaceOnly=true", async () => {
    const insideFile = path.join(workspaceDir, "inside.txt");
    await fs.writeFile(insideFile, "seed", "utf8");
    const writeTool = requireTool(toolsFor(true), "write");

    await writeTool.execute("test-call-append-inside", {
      path: insideFile,
      content: "+inside",
      append: true,
    });
    await expect(fs.readFile(insideFile, "utf8")).resolves.toBe("seed+inside");
    await expect(
      writeTool.execute("test-call-append-outside-blocked", {
        path: outsideFile,
        content: "+outside",
        append: true,
      }),
    ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
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
      append: true,
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

  it("uses a sandbox bridge native append for memory-triggered writes when available", async () => {
    const allowedRelativePath = "memory/2026-03-10.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed", "utf8");
    const bridge = createHostSandboxFsBridge(workspaceDir);
    const appendSpy = vi.spyOn(bridge, "appendFile");
    const writeSpy = vi.spyOn(bridge, "writeFile");
    const writeTool = wrapToolMemoryFlushAppendOnlyWrite(
      createHostWorkspaceWriteTool(workspaceDir),
      {
        root: workspaceDir,
        relativePath: allowedRelativePath,
        sandbox: { root: workspaceDir, bridge },
      },
    );

    const result = await writeTool.execute("test-call-memory-sandbox-append", {
      path: allowedRelativePath,
      content: "native append",
      append: true,
    });

    expect(hasToolError(result)).toBe(false);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
    await expect(fs.readFile(allowedAbsolutePath, "utf8")).resolves.toBe("seed\nnative append");
  });

  it("marks a sandbox memory append uncertain when mutation precedes backend rejection", async () => {
    const allowedRelativePath = "memory/2026-03-11.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed", "utf8");
    const bridge = createHostSandboxFsBridge(workspaceDir);
    const appendFile = bridge.appendFile?.bind(bridge);
    if (!appendFile) {
      throw new Error("test bridge must support append");
    }
    bridge.appendFile = async (params) => {
      await appendFile(params);
      throw new Error("fsync timed out");
    };
    const writeTool = wrapToolMemoryFlushAppendOnlyWrite(
      createHostWorkspaceWriteTool(workspaceDir),
      {
        root: workspaceDir,
        relativePath: allowedRelativePath,
        sandbox: { root: workspaceDir, bridge },
      },
    );

    await expect(
      writeTool.execute("test-call-memory-sandbox-uncertain-after", {
        path: allowedRelativePath,
        content: "durable note",
        append: true,
      }),
    ).rejects.toThrow(/Append outcome is uncertain; do not retry automatically/);
    await expect(fs.readFile(allowedAbsolutePath, "utf8")).resolves.toBe("seed\ndurable note");
  });

  it("marks a sandbox memory append uncertain when the backend rejects before persistence", async () => {
    const allowedRelativePath = "memory/2026-03-12.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed", "utf8");
    const bridge = createHostSandboxFsBridge(workspaceDir);
    bridge.appendFile = async () => {
      throw new Error("remote append rejected");
    };
    const writeTool = wrapToolMemoryFlushAppendOnlyWrite(
      createHostWorkspaceWriteTool(workspaceDir),
      {
        root: workspaceDir,
        relativePath: allowedRelativePath,
        sandbox: { root: workspaceDir, bridge },
      },
    );

    await expect(
      writeTool.execute("test-call-memory-sandbox-uncertain-before", {
        path: allowedRelativePath,
        content: "not persisted",
        append: true,
      }),
    ).rejects.toThrow(/Append outcome is uncertain; do not retry automatically/);
    await expect(fs.readFile(allowedAbsolutePath, "utf8")).resolves.toBe("seed");
  });

  it("accepts sandbox memory append acknowledgement before late cancellation", async () => {
    const allowedRelativePath = "memory/2026-03-13.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed", "utf8");
    const bridge = createHostSandboxFsBridge(workspaceDir);
    const appendFile = bridge.appendFile?.bind(bridge);
    if (!appendFile) {
      throw new Error("test bridge must support append");
    }
    const controller = new AbortController();
    bridge.appendFile = async (params) => {
      await appendFile(params);
      controller.abort();
    };
    const writeTool = wrapToolMemoryFlushAppendOnlyWrite(
      createHostWorkspaceWriteTool(workspaceDir),
      {
        root: workspaceDir,
        relativePath: allowedRelativePath,
        sandbox: { root: workspaceDir, bridge },
      },
    );

    const result = await writeTool.execute(
      "test-call-memory-sandbox-acknowledged",
      {
        path: allowedRelativePath,
        content: "acknowledged",
        append: true,
      },
      controller.signal,
    );

    expect(hasToolError(result)).toBe(false);
    await expect(fs.readFile(allowedAbsolutePath, "utf8")).resolves.toBe("seed\nacknowledged");
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
