import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkdir } from "./bash-tools.shared.js";

type WriteOps = {
  mkdir: (dir: string) => Promise<void>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
};
type EditOps = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
};

const captured = vi.hoisted(() => ({
  writeOps: undefined as WriteOps | undefined,
  editOps: undefined as EditOps | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createWriteTool: (_cwd: string, options?: { operations?: WriteOps }) => {
      captured.writeOps = options?.operations;
      return {
        name: "write",
        description: "test write tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
    createEditTool: (_cwd: string, options?: { operations?: EditOps }) => {
      captured.editOps = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
  };
});

const { createHostWorkspaceWriteTool, createHostWorkspaceEditTool } =
  await import("./pi-tools.read.js");

describe("tilde expansion in tool path resolution", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tilde-test-"));
  });

  afterEach(async () => {
    captured.writeOps = undefined;
    captured.editOps = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("host-wide write (workspaceOnly=false)", () => {
    it("expands ~ in writeFile path", async () => {
      const home = os.homedir();
      const fileName = `.openclaw-tilde-test-${Date.now()}.tmp`;
      const testFile = path.join(home, fileName);

      createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
      expect(captured.writeOps).toBeDefined();

      try {
        await captured.writeOps!.writeFile(`~/${fileName}`, "hello");
        const content = await fs.readFile(testFile, "utf-8");
        expect(content).toBe("hello");
      } finally {
        await fs.rm(testFile, { force: true }).catch(() => {});
      }
    });

    it("expands ~ in mkdir path", async () => {
      const dirName = `.openclaw-tilde-mkdir-test-${Date.now()}`;
      const home = os.homedir();
      const expected = path.join(home, dirName);

      createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
      expect(captured.writeOps).toBeDefined();

      try {
        await captured.writeOps!.mkdir(`~/${dirName}`);
        const stat = await fs.stat(expected);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        await fs.rm(expected, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("host-wide edit (workspaceOnly=false)", () => {
    it("expands ~ in readFile path", async () => {
      const fileName = `.openclaw-tilde-read-test-${Date.now()}.tmp`;
      const home = os.homedir();
      const filePath = path.join(home, fileName);

      await fs.writeFile(filePath, "tilde-test-content", "utf-8");

      createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
      expect(captured.editOps).toBeDefined();

      try {
        const content = await captured.editOps!.readFile(`~/${fileName}`);
        expect(content.toString()).toBe("tilde-test-content");
      } finally {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    });

    it("expands ~ in access check", async () => {
      const fileName = `.openclaw-tilde-access-test-${Date.now()}.tmp`;
      const home = os.homedir();
      const filePath = path.join(home, fileName);

      await fs.writeFile(filePath, "exists", "utf-8");

      createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
      expect(captured.editOps).toBeDefined();

      try {
        // Should not throw — file exists at expanded ~ path.
        await captured.editOps!.access(`~/${fileName}`);
      } finally {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    });
  });

  describe("workspace-mode (workspaceOnly=true)", () => {
    it("rejects ~ paths that resolve outside workspace root", async () => {
      createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: true });
      expect(captured.writeOps).toBeDefined();

      // ~ expands to home dir which is outside tmpDir workspace
      await expect(captured.writeOps!.writeFile("~/outside.txt", "data")).rejects.toThrow(
        /escapes workspace root/i,
      );
    });

    it("accepts ~ paths when workspace root is under home", async () => {
      const home = os.homedir();
      const workspaceInHome = path.join(home, `.openclaw-tilde-ws-${Date.now()}`);
      await fs.mkdir(workspaceInHome, { recursive: true });

      createHostWorkspaceEditTool(workspaceInHome, { workspaceOnly: true });
      expect(captured.editOps).toBeDefined();

      const testFile = path.join(workspaceInHome, "test.txt");
      await fs.writeFile(testFile, "in-workspace", "utf-8");

      try {
        // ~/.<workspace-name>/test.txt should resolve inside the workspace
        const wsBasename = path.basename(workspaceInHome);
        const content = await captured.editOps!.readFile(`~/${wsBasename}/test.txt`);
        expect(content.toString()).toBe("in-workspace");
      } finally {
        await fs.rm(workspaceInHome, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("paths without tilde are unaffected", () => {
    it("resolves absolute paths normally", async () => {
      const testFile = path.join(tmpDir, "absolute.txt");
      await fs.writeFile(testFile, "absolute-content", "utf-8");

      createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
      expect(captured.editOps).toBeDefined();

      const content = await captured.editOps!.readFile(testFile);
      expect(content.toString()).toBe("absolute-content");
    });
  });

  describe("exec/bash workdir tilde expansion", () => {
    it("resolves ~ workdir to home directory", () => {
      const warnings: string[] = [];
      const result = resolveWorkdir("~", warnings);
      expect(result).toBe(os.homedir());
      expect(warnings).toHaveLength(0);
    });

    it("resolves ~/subdir workdir to home subdirectory", async () => {
      const dirName = `.openclaw-tilde-workdir-test-${Date.now()}`;
      const expected = path.join(os.homedir(), dirName);
      await fs.mkdir(expected, { recursive: true });

      try {
        const warnings: string[] = [];
        const result = resolveWorkdir(`~/${dirName}`, warnings);
        expect(result).toBe(expected);
        expect(warnings).toHaveLength(0);
      } finally {
        await fs.rm(expected, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("falls back when ~ subdir does not exist", () => {
      const warnings: string[] = [];
      const result = resolveWorkdir("~/nonexistent-dir-that-should-not-exist-12345", warnings);
      // Should fall back to cwd or homedir, with a warning
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/unavailable/);
      expect(result).not.toContain("~");
    });
  });
});
