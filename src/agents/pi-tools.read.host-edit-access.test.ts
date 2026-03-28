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
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")(
    "surfaces the real boundary error instead of collapsing outside-workspace edits into file-not-found",
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

      const editTool = createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });

      await expect(
        editTool.execute("tc-edit", {
          path: path.join(workspaceDir, "escape", "secret.txt"),
          edits: [{ oldText: "secret", newText: "updated" }],
        }),
      ).rejects.toThrow(/outside workspace root|path escapes workspace root|outside-workspace/i);
    },
  );
});
