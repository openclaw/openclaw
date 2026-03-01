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

describe("createHostWorkspaceEditTool host access mapping", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.operations = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")(
    "maps outside-workspace safe-open failures to EACCES",
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

      await expect(
        mocks.operations!.access(path.join(workspaceDir, "escape", "secret.txt")),
      ).rejects.toMatchObject({ code: "EACCES" });
    },
  );
});
