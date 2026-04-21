import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedEditOperations = {
  access: (absolutePath: string) => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  operations: undefined as CapturedEditOperations | undefined,
  executeImpl: undefined as
    | ((...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }> }>)
    | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: { operations?: CapturedEditOperations }) => {
      mocks.operations = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async (...args: unknown[]) =>
          mocks.executeImpl
            ? await mocks.executeImpl(...args)
            : {
                content: [{ type: "text" as const, text: "ok" }],
              },
      };
    },
  };
});

const { createHostWorkspaceEditTool } = await import("./pi-tools.read.js");

describe("createHostWorkspaceEditTool host access mapping", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.operations = undefined;
    mocks.executeImpl = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")(
    "silently passes access for outside-workspace paths so readFile reports the real error",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-access-test-"));
      const workspaceDir = path.join(tmpDir, "workspace");
      const outsideDir = path.join(tmpDir, "outside");
      const linkDir = path.join(workspaceDir, "escape");
      const outsideFile = path.join(outsideDir, "secret.txt");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "secret", "utf8");
      await fs.symlink(outsideDir, linkDir);

      createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
      expect(mocks.operations).toBeDefined();

      // access must NOT throw for outside-workspace paths; the upstream
      // library replaces any access error with a misleading "File not found".
      // By resolving silently the subsequent readFile call surfaces the real
      // "Path escapes workspace root" / "outside-workspace" error instead.
      await expect(
        mocks.operations!.access(path.join(workspaceDir, "escape", "secret.txt")),
      ).resolves.toBeUndefined();
    },
  );

  it("does not leak outside-root file contents through edit recovery reads", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const outsideDir = path.join(tmpDir, "outside");
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(outsideFile, "top-secret", "utf8");

    mocks.executeImpl = async () => {
      throw new Error("Could not find the exact text in secret.txt");
    };

    const tool = createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
    const error = await tool
      .execute("recovery-outside", {
        path: outsideFile,
        edits: [{ oldText: "missing", newText: "updated" }],
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Could not find the exact text in secret\.txt/);
    expect((error as Error).message).not.toContain("top-secret");
  });
});
