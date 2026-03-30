import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
  };
});

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: () => undefined,
    getOAuthProviders: () => [],
  };
});

import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolWorkspaceRootGuard,
} from "./pi-tools.read.js";
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

  const runFsTool = async (
    toolName: "write" | "edit" | "read",
    callId: string,
    input: Record<string, unknown>,
    workspaceOnly: boolean | undefined,
  ) => {
    const tool = toolsFor(workspaceOnly).find((candidate) => candidate.name === toolName);
    expect(tool).toBeDefined();
    const result = await tool!.execute(callId, input);
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

    await runFsTool(
      "read",
      "test-call-3",
      {
        path: outsideFile,
      },
      false,
    );
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
    const writeTool = tools.find((t) => t.name === "write");
    expect(writeTool).toBeDefined();

    // When workspaceOnly=true, the guard throws an error
    await expect(
      writeTool!.execute("test-call-4", {
        path: outsideFile,
        content: "test content",
      }),
    ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
  });

  it("restricts memory-triggered writes to append-only canonical memory files", async () => {
    const allowedRelativePath = "memory/2026-03-07.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed");

    const tools = [
      createOpenClawReadTool(createReadTool(workspaceDir) as unknown as AnyAgentTool),
      wrapToolMemoryFlushAppendOnlyWrite(createHostWorkspaceWriteTool(workspaceDir), {
        root: workspaceDir,
        relativePath: allowedRelativePath,
      }),
    ];

    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(["read", "write"]);

    await expect(
      writeTool!.execute("test-call-memory-deny", {
        path: outsideFile,
        content: "should not write here",
      }),
    ).rejects.toThrow(/Memory flush writes are restricted to memory\/2026-03-07\.md/);

    const result = await writeTool!.execute("test-call-memory-append", {
      path: allowedRelativePath,
      content: "new note",
    });
    expect(hasToolError(result)).toBe(false);
    expect(result.content).toContainEqual({
      type: "text",
      text: "Appended content to memory/2026-03-07.md.",
    });
    await expect(fs.readFile(allowedAbsolutePath, "utf-8")).resolves.toBe("seed\nnew note");
  });

  it("blocks memory flush writes when the flush file is outside configured fs roots", async () => {
    const allowedRelativePath = "memory/2026-03-07.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    const allowedRootDir = path.join(tmpDir, "outside-root");
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.mkdir(allowedRootDir, { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      trigger: "memory",
      memoryFlushWritePath: allowedRelativePath,
      config: {
        tools: {
          exec: {
            applyPatch: {},
          },
          fs: {
            roots: [{ path: allowedRootDir, kind: "dir", access: "rw" }],
          },
        },
      },
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    await expect(
      writeTool!.execute("test-call-memory-roots-deny", {
        path: allowedRelativePath,
        content: "new note",
      }),
    ).rejects.toThrow(/outside allowed filesystem roots/);
    await expect(fs.readFile(allowedAbsolutePath, "utf-8")).resolves.toBe("seed");
  });

  it("allows memory flush writes when an exact file root permits the flush file", async () => {
    const allowedRelativePath = "memory/2026-03-07.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      trigger: "memory",
      memoryFlushWritePath: allowedRelativePath,
      config: {
        tools: {
          exec: {
            applyPatch: {},
          },
          fs: {
            roots: [{ path: allowedAbsolutePath, kind: "file", access: "rw" }],
          },
        },
      },
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    const result = await writeTool!.execute("test-call-memory-roots-allow", {
      path: allowedRelativePath,
      content: "new note",
    });
    expect(hasToolError(result)).toBe(false);
    await expect(fs.readFile(allowedAbsolutePath, "utf-8")).resolves.toBe("seed\nnew note");
  });

  it("allows reads outside the workspace when fs roots permit them", async () => {
    const allowedDir = path.join(tmpDir, "outside-read-root");
    const allowedFile = path.join(allowedDir, "note.txt");
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.writeFile(allowedFile, "hello from roots");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: {
        tools: {
          fs: {
            roots: [{ path: allowedDir, kind: "dir", access: "rw" }],
          },
        },
      },
    });

    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const result = await readTool!.execute("test-call-roots-read-allow", {
      path: allowedFile,
    });
    expect(hasToolError(result)).toBe(false);
    expect(result.content).toContainEqual({
      type: "text",
      text: "hello from roots",
    });
  });

  it.runIf(process.platform !== "win32")(
    "blocks read symlink aliases that escape configured fs roots",
    async () => {
      const allowedDir = path.join(tmpDir, "outside-read-root");
      const outsideDir = path.join(tmpDir, "outside-secret-root");
      const aliasFile = path.join(allowedDir, "alias.txt");
      const outsideFile = path.join(outsideDir, "secret.txt");
      await fs.mkdir(allowedDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "secret");
      await fs.symlink(outsideFile, aliasFile);

      const tools = createOpenClawCodingTools({
        workspaceDir,
        config: {
          tools: {
            fs: {
              roots: [{ path: allowedDir, kind: "dir", access: "rw" }],
            },
          },
        },
      });

      const readTool = tools.find((tool) => tool.name === "read");
      expect(readTool).toBeDefined();

      await expect(
        readTool!.execute("test-call-roots-read-deny", {
          path: aliasFile,
        }),
      ).rejects.toThrow(/symlink escapes fs root|outside workspace root|regular file under root/i);
    },
  );
});
