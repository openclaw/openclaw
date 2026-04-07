import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedEditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
};

type CapturedWriteOperations = {
  mkdir: (dir: string) => Promise<void>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  editOps: undefined as CapturedEditOperations | undefined,
  writeOps: undefined as CapturedWriteOperations | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: { operations?: CapturedEditOperations }) => {
      mocks.editOps = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
    createWriteTool: (_cwd: string, options?: { operations?: CapturedWriteOperations }) => {
      mocks.writeOps = options?.operations;
      return {
        name: "write",
        description: "test write tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
  };
});

const { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } =
  await import("./pi-tools.read.js");

describe("host tool tilde expansion (non-workspace mode)", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.editOps = undefined;
    mocks.writeOps = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("edit readFile expands ~ to home directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tilde-edit-"));
    const testFile = path.join(tmpDir, "test.txt");
    await fs.writeFile(testFile, "hello", "utf8");

    const homeRelative = testFile.replace(os.homedir(), "~");
    // Only run when the file is actually under $HOME (common on macOS/Linux)
    if (!testFile.startsWith(os.homedir())) {
      return;
    }

    createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    expect(mocks.editOps).toBeDefined();

    const content = await mocks.editOps!.readFile(homeRelative);
    expect(content.toString("utf8")).toBe("hello");
  });

  it("edit access expands ~ to home directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tilde-edit-"));
    const testFile = path.join(tmpDir, "test.txt");
    await fs.writeFile(testFile, "hello", "utf8");

    const homeRelative = testFile.replace(os.homedir(), "~");
    if (!testFile.startsWith(os.homedir())) {
      return;
    }

    createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    expect(mocks.editOps).toBeDefined();

    await expect(mocks.editOps!.access(homeRelative)).resolves.toBeUndefined();
  });

  it("write writeFile expands ~ to home directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tilde-write-"));
    const testFile = path.join(tmpDir, "tilde-write-test.txt");

    const homeRelative = testFile.replace(os.homedir(), "~");
    if (!testFile.startsWith(os.homedir())) {
      return;
    }

    createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    expect(mocks.writeOps).toBeDefined();

    await mocks.writeOps!.writeFile(homeRelative, "written via tilde");
    const content = await fs.readFile(testFile, "utf8");
    expect(content).toBe("written via tilde");
  });

  it("write mkdir expands ~ to home directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tilde-mkdir-"));
    const newDir = path.join(tmpDir, "subdir");

    const homeRelative = newDir.replace(os.homedir(), "~");
    if (!newDir.startsWith(os.homedir())) {
      return;
    }

    createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    expect(mocks.writeOps).toBeDefined();

    await mocks.writeOps!.mkdir(homeRelative);
    const stat = await fs.stat(newDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
