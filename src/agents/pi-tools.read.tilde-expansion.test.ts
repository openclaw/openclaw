import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedEditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
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

const { createHostWorkspaceEditTool, expandTilde } = await import("./pi-tools.read.js");

describe("expandTilde", () => {
  it("expands bare ~ to homedir", () => {
    expect(expandTilde("~")).toBe(os.homedir());
  });

  it("expands ~/ prefix to homedir", () => {
    expect(expandTilde("~/foo/bar.txt")).toBe(path.join(os.homedir(), "foo/bar.txt"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("foo/bar")).toBe("foo/bar");
  });

  it("does not expand ~user form (only bare ~)", () => {
    expect(expandTilde("~otheruser/file")).toBe("~otheruser/file");
  });
});

describe("createHostWorkspaceEditTool tilde expansion", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.operations = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")(
    "tilde path outside workspace yields EACCES, not ENOENT",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tilde-test-"));
      const workspaceDir = path.join(tmpDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
      expect(mocks.operations).toBeDefined();

      // ~/.npm-global/lib/foo.txt is outside the workspace; should get EACCES
      await expect(mocks.operations!.access("~/.npm-global/lib/foo.txt")).rejects.toMatchObject({
        code: "EACCES",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "tilde path inside workspace resolves correctly",
    async () => {
      // Create workspace under the real homedir so ~/... can resolve inside it
      const home = os.homedir();
      tmpDir = await fs.mkdtemp(path.join(home, ".openclaw-tilde-test-"));
      const testFile = path.join(tmpDir, "hello.txt");
      await fs.writeFile(testFile, "world", "utf8");

      createHostWorkspaceEditTool(tmpDir, { workspaceOnly: true });
      expect(mocks.operations).toBeDefined();

      // Build a ~/... path that points inside the workspace
      const relative = path.relative(home, testFile);
      const tildePath = `~/${relative}`;

      const buf = await mocks.operations!.readFile(tildePath);
      expect(buf.toString("utf8")).toBe("world");
    },
  );
});
