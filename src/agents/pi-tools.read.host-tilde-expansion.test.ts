import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// The vitest global-setup isolates HOME to a temp dir (test/test-env.ts),
// but Node's os.homedir() bypasses env and still returns the real OS home.
// expandHomePrefix reads process.env.HOME first, so tests must match that to
// keep tilde paths consistent with what the production code resolves.
const effectiveHome = () => process.env.HOME ?? os.homedir();

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
    tmpDir = await fs.mkdtemp(path.join(effectiveHome(), ".openclaw-tilde-test-edit-"));
    const testFile = path.join(tmpDir, "test.txt");
    await fs.writeFile(testFile, "hello", "utf8");

    const homeRelative = testFile.replace(effectiveHome(), "~");

    createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    expect(mocks.editOps).toBeDefined();

    const content = await mocks.editOps!.readFile(homeRelative);
    expect(content.toString("utf8")).toBe("hello");
  });

  it("edit access expands ~ to home directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(effectiveHome(), ".openclaw-tilde-test-edit-"));
    const testFile = path.join(tmpDir, "test.txt");
    await fs.writeFile(testFile, "hello", "utf8");

    const homeRelative = testFile.replace(effectiveHome(), "~");

    createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    expect(mocks.editOps).toBeDefined();

    await expect(mocks.editOps!.access(homeRelative)).resolves.toBeUndefined();
  });

  it("write writeFile expands ~ to home directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(effectiveHome(), ".openclaw-tilde-test-write-"));
    const testFile = path.join(tmpDir, "tilde-write-test.txt");

    const homeRelative = testFile.replace(effectiveHome(), "~");

    createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    expect(mocks.writeOps).toBeDefined();

    await mocks.writeOps!.writeFile(homeRelative, "written via tilde");
    const content = await fs.readFile(testFile, "utf8");
    expect(content).toBe("written via tilde");
  });

  it("write mkdir expands ~ to home directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(effectiveHome(), ".openclaw-tilde-test-mkdir-"));
    const newDir = path.join(tmpDir, "subdir");

    const homeRelative = newDir.replace(effectiveHome(), "~");

    createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    expect(mocks.writeOps).toBeDefined();

    await mocks.writeOps!.mkdir(homeRelative);
    const stat = await fs.stat(newDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

// These tests set OPENCLAW_HOME to a dir that is explicitly NOT under $HOME
// and verify tilde expansion resolves to OPENCLAW_HOME. Without the
// expandHomePrefix fix, the production code would use os.homedir() / $HOME
// and the target files would land in the wrong location. Follows the
// snapshot/restore pattern from test/helpers/temp-home.ts.
describe("host tool tilde expansion honors OPENCLAW_HOME override", () => {
  let openclawHome = "";
  const originalOpenclawHome = process.env.OPENCLAW_HOME;

  beforeEach(async () => {
    openclawHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-override-"));
    process.env.OPENCLAW_HOME = openclawHome;
  });

  afterEach(async () => {
    if (originalOpenclawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenclawHome;
    }
    mocks.editOps = undefined;
    mocks.writeOps = undefined;
    if (openclawHome) {
      await fs.rm(openclawHome, { recursive: true, force: true });
      openclawHome = "";
    }
  });

  it("write writeFile resolves ~ to OPENCLAW_HOME when it differs from $HOME", async () => {
    createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
    expect(mocks.writeOps).toBeDefined();

    await mocks.writeOps!.writeFile("~/openclaw-home-write.txt", "content via OPENCLAW_HOME");

    // File must land under OPENCLAW_HOME (proving expandHomePrefix honored
    // the override), not under $HOME / os.homedir().
    const expectedPath = path.join(openclawHome, "openclaw-home-write.txt");
    const content = await fs.readFile(expectedPath, "utf8");
    expect(content).toBe("content via OPENCLAW_HOME");
  });

  it("write mkdir resolves ~ to OPENCLAW_HOME when it differs from $HOME", async () => {
    createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
    expect(mocks.writeOps).toBeDefined();

    await mocks.writeOps!.mkdir("~/openclaw-home-mkdir");

    const stat = await fs.stat(path.join(openclawHome, "openclaw-home-mkdir"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("edit readFile resolves ~ to OPENCLAW_HOME when it differs from $HOME", async () => {
    await fs.writeFile(
      path.join(openclawHome, "openclaw-home-read.txt"),
      "OPENCLAW_HOME content",
      "utf8",
    );

    createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });
    expect(mocks.editOps).toBeDefined();

    const content = await mocks.editOps!.readFile("~/openclaw-home-read.txt");
    expect(content.toString("utf8")).toBe("OPENCLAW_HOME content");
  });

  it("edit access resolves ~ to OPENCLAW_HOME when it differs from $HOME", async () => {
    await fs.writeFile(path.join(openclawHome, "openclaw-home-access.txt"), "exists", "utf8");

    createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });
    expect(mocks.editOps).toBeDefined();

    await expect(mocks.editOps!.access("~/openclaw-home-access.txt")).resolves.toBeUndefined();
  });
});
