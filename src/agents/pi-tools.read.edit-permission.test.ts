import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessPolicyConfig } from "../config/types.tools.js";

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

const { createHostWorkspaceEditTool } = await import("./pi-tools.read.js");

describe("createHostWorkspaceEditTool edit read-permission check", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.operations = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")(
    "readFile throws when read access is denied by permissions (write-only policy)",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-perm-test-"));
      const filePath = path.join(tmpDir, "protected.txt");
      await fs.writeFile(filePath, "secret content", "utf8");

      // "-w-" policy: write allowed, read denied.
      // Edit must NOT be allowed to read the file even if write is permitted.
      const permissions: AccessPolicyConfig = {
        policy: { [`${tmpDir}/**`]: "-w-" },
      };
      createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false, permissions });
      expect(mocks.operations).toBeDefined();

      await expect(mocks.operations!.readFile(filePath)).rejects.toThrow(/Permission denied.*read/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "readFile succeeds when read access is granted by permissions",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-perm-test-"));
      const filePath = path.join(tmpDir, "allowed.txt");
      await fs.writeFile(filePath, "content", "utf8");

      const permissions: AccessPolicyConfig = {
        policy: { [`${tmpDir}/**`]: "rw-" },
      };
      createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false, permissions });
      expect(mocks.operations).toBeDefined();

      await expect(mocks.operations!.readFile(filePath)).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "writeFile throws when write access is denied by permissions",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-perm-test-"));
      const filePath = path.join(tmpDir, "readonly.txt");
      await fs.writeFile(filePath, "content", "utf8");

      // "r--" policy: read allowed, write denied.
      const permissions: AccessPolicyConfig = {
        policy: { [`${tmpDir}/**`]: "r--" },
      };
      createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false, permissions });
      expect(mocks.operations).toBeDefined();

      await expect(mocks.operations!.writeFile(filePath, "new")).rejects.toThrow(
        /Permission denied.*write/,
      );
    },
  );
});
