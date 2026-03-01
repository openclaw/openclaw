import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedEditOperations = {
  access: (absolutePath: string) => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  operations: undefined as CapturedEditOperations | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: { operations?: CapturedEditOperations }) => {
      mocks.operations = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      };
    },
  };
});

const { createHostWorkspaceEditTool } = await import("./pi-tools.read.js");

describe("createHostWorkspaceEditTool workspace escape error", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.operations = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("access throws EACCES with correct message for paths outside workspace", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-escape-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const outsideDir = path.join(tmpDir, "outside");

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    // Create a file outside the workspace
    const outsideFile = path.join(outsideDir, "test.txt");
    await fs.writeFile(outsideFile, "content");

    createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
    expect(mocks.operations).toBeDefined();

    // Attempt to access a file outside the workspace
    let error: NodeJS.ErrnoException | undefined;
    try {
      await mocks.operations!.access(outsideFile);
    } catch (e) {
      error = e as NodeJS.ErrnoException;
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe("EACCES");
    expect(error?.message).toContain("Path escapes workspace root");
    expect(error?.message).toContain(outsideFile);
  });

  it("access throws ENOENT for non-existent files inside workspace", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-escape-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");

    await fs.mkdir(workspaceDir, { recursive: true });

    createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
    expect(mocks.operations).toBeDefined();

    // Attempt to access a non-existent file inside the workspace
    let error: NodeJS.ErrnoException | undefined;
    try {
      await mocks.operations!.access(path.join(workspaceDir, "non-existent.txt"));
    } catch (e) {
      error = e as NodeJS.ErrnoException;
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe("ENOENT");
  });

  it("access succeeds for existing files inside workspace", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-escape-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");

    await fs.mkdir(workspaceDir, { recursive: true });

    // Create a file inside the workspace
    const testFile = path.join(workspaceDir, "test.txt");
    await fs.writeFile(testFile, "content");

    createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
    expect(mocks.operations).toBeDefined();

    // Should not throw
    await expect(mocks.operations!.access(testFile)).resolves.toBeUndefined();
  });

  it("access throws EACCES for paths with directory traversal outside workspace", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-escape-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const outsideDir = path.join(tmpDir, "outside");

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    // Create a file outside the workspace
    await fs.writeFile(path.join(outsideDir, "test.txt"), "content");

    createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
    expect(mocks.operations).toBeDefined();

    // Attempt to access using ../ traversal
    let error: NodeJS.ErrnoException | undefined;
    try {
      await mocks.operations!.access(path.join(workspaceDir, "..", "outside", "test.txt"));
    } catch (e) {
      error = e as NodeJS.ErrnoException;
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe("EACCES");
    expect(error?.message).toContain("Path escapes workspace root");
  });
});
