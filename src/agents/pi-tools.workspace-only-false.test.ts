import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...original,
  };
});

vi.mock("@earendil-works/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/oauth")>(
    "@earendil-works/pi-ai/oauth",
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

  const expectDeniedMutation = async (
    operation: () => Promise<{ content: Array<{ type: string; text?: string }> }>,
  ) => {
    try {
      const result = await operation();
      expect(hasToolError(result)).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/denied|mutation policy/i);
    } catch (error) {
      if (!(error instanceof Error)) {
        expect(String(error)).toMatch(/denied-path|denied|mutation policy/i);
        return;
      }

      const code = (error as { code?: unknown }).code;
      const text = `${typeof code === "string" ? code : ""} ${error.message}`;
      expect(text).toMatch(/denied-path|denied|mutation policy/i);
    }
  };

  const stubHostHome = async () => {
    const homeDir = path.join(tmpDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tmpDir, "state"));
    vi.stubEnv("OPENCLAW_OAUTH_DIR", path.join(tmpDir, "oauth"));
    return homeDir;
  };

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
    vi.unstubAllEnvs();
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

  it("should allow write through a non-sensitive symlink when workspaceOnly=false", async () => {
    if (process.platform === "win32") {
      return;
    }
    const realFile = path.join(tmpDir, "symlink-real.txt");
    const linkFile = path.join(tmpDir, "symlink-link.txt");
    await fs.writeFile(realFile, "before");
    await fs.symlink(realFile, linkFile);

    await runFsTool(
      "write",
      "test-call-symlink-write",
      {
        path: linkFile,
        content: "after",
      },
      false,
    );

    await expect(fs.readFile(realFile, "utf-8")).resolves.toBe("after");
  });

  it("denies writes through hardlink aliases to sensitive host paths when workspaceOnly=false", async () => {
    if (process.platform === "win32") {
      return;
    }
    const homeDir = await stubHostHome();
    const target = path.join(homeDir, ".netrc");
    const alias = path.join(tmpDir, "netrc-hardlink-alias");
    await fs.writeFile(target, "machine example.com\n", "utf-8");
    await fs.link(target, alias);
    const writeTool = requireTool(toolsFor(false), "write");

    await expectDeniedMutation(() =>
      writeTool.execute("test-call-deny-sensitive-hardlink-write", {
        path: alias,
        content: "machine evil.example.com\n",
      }),
    );

    await expect(fs.readFile(target, "utf-8")).resolves.toBe("machine example.com\n");
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

  it("denies writes to sensitive host paths when workspaceOnly=false", async () => {
    const homeDir = await stubHostHome();
    const target = path.join(homeDir, ".ssh", "authorized_keys");
    const writeTool = requireTool(toolsFor(false), "write");

    await expectDeniedMutation(() =>
      writeTool.execute("test-call-deny-sensitive-write", {
        path: target,
        content: "ssh-rsa should-not-write",
      }),
    );

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies edits to sensitive host paths when workspaceOnly=false", async () => {
    const homeDir = await stubHostHome();
    const target = path.join(homeDir, ".netrc");
    await fs.writeFile(target, "machine example.com\n", "utf-8");
    const editTool = requireTool(toolsFor(false), "edit");

    await expectDeniedMutation(() =>
      editTool.execute("test-call-deny-sensitive-edit", {
        path: target,
        edits: [{ oldText: "example.com", newText: "evil.example.com" }],
      }),
    );

    await expect(fs.readFile(target, "utf-8")).resolves.toBe("machine example.com\n");
  });

  it("denies writes to configured agent auth stores when workspaceOnly=false", async () => {
    await stubHostHome();
    const agentDir = path.join(tmpDir, "configured-agent");
    const target = path.join(agentDir, "auth-profiles.json");
    const writeTool = createHostWorkspaceWriteTool(workspaceDir, {
      workspaceOnly: false,
      denyMutationAgentDirs: [agentDir],
    });

    await expectDeniedMutation(() =>
      writeTool.execute("test-call-deny-configured-agent-auth", {
        path: target,
        content: "{}\n",
      }),
    );

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies sensitive paths inside the workspace root when workspaceOnly=true", async () => {
    const homeDir = await stubHostHome();
    const target = path.join(homeDir, ".ssh", "authorized_keys");
    const writeTool = createHostWorkspaceWriteTool(homeDir, { workspaceOnly: true });

    await expectDeniedMutation(() =>
      writeTool.execute("test-call-deny-sensitive-workspace-write", {
        path: target,
        content: "ssh-rsa should-not-write",
      }),
    );

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
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

    const writeTool = requireTool(tools, "write");
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(["read", "write"]);

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
});
