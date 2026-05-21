import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type MockFsSafeRoot = {
  write: (relativePath: string, content: string, options: { mkdir?: boolean }) => Promise<void>;
  read: (relativePath: string) => Promise<{ buffer: Buffer }>;
  open: (relativePath: string) => Promise<{ handle: { close: () => Promise<void> } }>;
};

const mockRoot: MockFsSafeRoot = {
  write: vi.fn(async () => {}),
  read: vi.fn(async () => ({ buffer: Buffer.from("mock content") })),
  open: vi.fn(async () => ({ handle: { close: vi.fn(async () => {}) } })),
};

let capturedWriteOps: { writeFile?: (absolutePath: string, content: string) => Promise<void> } = {};
let capturedEditOps: { writeFile?: (absolutePath: string, content: string) => Promise<void> } = {};

vi.mock("../infra/fs-safe.js", () => ({
  root: vi.fn(async () => mockRoot),
  FsSafeError: class FsSafeError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    createWriteTool: (_cwd: string, options?: { operations?: typeof capturedWriteOps }) => {
      capturedWriteOps = options?.operations ?? {};
      return {
        name: "write",
        description: "test write tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      };
    },
    createEditTool: (_cwd: string, options?: { operations?: typeof capturedEditOps }) => {
      capturedEditOps = options?.operations ?? {};
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

describe("createHostWriteOperations symlink resolution", () => {
  let tmpDir = "";
  let createHostWorkspaceWriteTool: typeof import("./pi-tools.read.js").createHostWorkspaceWriteTool;

  beforeAll(async () => {
    ({ createHostWorkspaceWriteTool } = await import("./pi-tools.read.js"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    capturedWriteOps = {};
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("resolves symlinks before computing relative path for writeFile", async () => {
    if (process.platform === "win32") {
      return;
    }
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-symlink-write-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const realDir = path.join(workspaceDir, "oc_system", "memory");
    const linkDir = path.join(workspaceDir, "memory");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, linkDir);

    const absolutePath = path.join(linkDir, "test.txt");

    createHostWorkspaceWriteTool(workspaceDir, { workspaceOnly: true });
    if (!capturedWriteOps.writeFile) {
      throw new Error("expected writeFile operation to be registered");
    }

    await capturedWriteOps.writeFile(absolutePath, "hello symlink");

    expect(mockRoot.write).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(mockRoot.write).mock.calls[0];
    expect(callArg[0]).toBe("oc_system/memory/test.txt");
    expect(callArg[1]).toBe("hello symlink");
    expect(callArg[2]).toEqual({ mkdir: true });
  });

  it("falls back to original path when realpath fails", async () => {
    if (process.platform === "win32") {
      return;
    }
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-symlink-fallback-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    // A path that doesn't exist - realpath will fail
    const absolutePath = path.join(workspaceDir, "nonexistent", "test.txt");

    createHostWorkspaceWriteTool(workspaceDir, { workspaceOnly: true });
    if (!capturedWriteOps.writeFile) {
      throw new Error("expected writeFile operation to be registered");
    }

    await capturedWriteOps.writeFile(absolutePath, "hello fallback");

    expect(mockRoot.write).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(mockRoot.write).mock.calls[0];
    expect(callArg[0]).toBe("nonexistent/test.txt");
    expect(callArg[1]).toBe("hello fallback");
  });

  it("works when workspace root itself is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ws-root-symlink-test-"));
    const realWorkspaceDir = path.join(tmpDir, "real_workspace");
    const linkWorkspaceDir = path.join(tmpDir, "link_workspace");
    await fs.mkdir(realWorkspaceDir, { recursive: true });
    await fs.symlink(realWorkspaceDir, linkWorkspaceDir);

    // Create a subdirectory in the real workspace
    const realSubdir = path.join(realWorkspaceDir, "subdir");
    await fs.mkdir(realSubdir, { recursive: true });

    // Write using the symlinked workspace root
    const absolutePath = path.join(linkWorkspaceDir, "subdir", "test.txt");

    createHostWorkspaceWriteTool(linkWorkspaceDir, { workspaceOnly: true });
    if (!capturedWriteOps.writeFile) {
      throw new Error("expected writeFile operation to be registered");
    }

    await capturedWriteOps.writeFile(absolutePath, "hello symlinked root");

    // fs-safe root should be created with the real path, and relative path
    // should be computed against the real workspace root
    expect(mockRoot.write).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(mockRoot.write).mock.calls[0];
    expect(callArg[0]).toBe("subdir/test.txt");
    expect(callArg[1]).toBe("hello symlinked root");
  });
});

describe("createHostEditOperations symlink resolution", () => {
  let tmpDir = "";
  let createHostWorkspaceEditTool: typeof import("./pi-tools.read.js").createHostWorkspaceEditTool;

  beforeAll(async () => {
    ({ createHostWorkspaceEditTool } = await import("./pi-tools.read.js"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    capturedEditOps = {};
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("resolves symlinks before computing relative path for writeFile", async () => {
    if (process.platform === "win32") {
      return;
    }
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-symlink-edit-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const realDir = path.join(workspaceDir, "oc_system", "memory");
    const linkDir = path.join(workspaceDir, "memory");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, linkDir);

    const absolutePath = path.join(linkDir, "test.txt");

    createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
    if (!capturedEditOps.writeFile) {
      throw new Error("expected writeFile operation to be registered");
    }

    await capturedEditOps.writeFile(absolutePath, "edited through symlink");

    expect(mockRoot.write).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(mockRoot.write).mock.calls[0];
    expect(callArg[0]).toBe("oc_system/memory/test.txt");
    expect(callArg[1]).toBe("edited through symlink");
  });
});
