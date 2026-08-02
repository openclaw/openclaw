import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSandboxedEditTool, createSandboxedWriteTool } from "./agent-tools.read.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

describe("sandbox mutation paths", () => {
  it.each(["write", "edit"] as const)(
    "serializes relative and sandbox-root absolute %s aliases",
    async (operation) => {
      const sandboxRoot = path.join(os.tmpdir(), `openclaw-sandbox-${operation}-queue`);
      let releaseFirstMutation!: () => void;
      const firstMutationGate = new Promise<void>((resolve) => {
        releaseFirstMutation = resolve;
      });
      let markFirstMutationEntered!: () => void;
      const firstMutationEntered = new Promise<void>((resolve) => {
        markFirstMutationEntered = resolve;
      });
      const writtenPaths: string[] = [];
      const bridge = {
        mkdirp: async () => {},
        stat: async () => (operation === "edit" ? { type: "file" as const, size: 6 } : null),
        readFile: async () => Buffer.from("before"),
        writeFile: async ({ filePath }: { filePath: string }) => {
          writtenPaths.push(filePath);
          if (writtenPaths.length === 1) {
            markFirstMutationEntered();
            await firstMutationGate;
          }
        },
      } as unknown as SandboxFsBridge;
      const absolutePath = path.join(sandboxRoot, "note.md");
      const mutate = (callId: string, filePath: string) =>
        operation === "write"
          ? createSandboxedWriteTool({ root: sandboxRoot, bridge }).execute(callId, {
              path: filePath,
              content: callId,
            })
          : createSandboxedEditTool({ root: sandboxRoot, bridge }).execute(callId, {
              path: filePath,
              edits: [{ oldText: "before", newText: "after" }],
            });

      const firstMutation = mutate(`sandbox-${operation}-relative`, "note.md");
      await firstMutationEntered;
      const secondMutation = mutate(`sandbox-${operation}-absolute`, absolutePath);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(writtenPaths).toEqual([absolutePath]);
      releaseFirstMutation();
      await Promise.all([firstMutation, secondMutation]);
      expect(writtenPaths).toEqual([absolutePath, absolutePath]);
    },
  );

  it("keeps POSIX drive paths unchanged through sandbox write and edit bridges", async () => {
    const drivePaths = ["/c/work/file.txt", "/cygdrive/c/work/file.txt", "/mnt/c/work/file.txt"];
    const writtenPaths: string[] = [];
    const editedPaths: string[] = [];
    const writeBridge = {
      mkdirp: async () => {},
      stat: async () => null,
      writeFile: async ({ filePath }: { filePath: string }) => {
        writtenPaths.push(filePath);
      },
    } as unknown as SandboxFsBridge;
    const editBridge = {
      stat: async () => ({ type: "file" as const, size: 6 }),
      readFile: async () => Buffer.from("before"),
      writeFile: async ({ filePath }: { filePath: string }) => {
        editedPaths.push(filePath);
      },
    } as unknown as SandboxFsBridge;
    const writeTool = createSandboxedWriteTool({ root: "/workspace", bridge: writeBridge });
    const editTool = createSandboxedEditTool({ root: "/workspace", bridge: editBridge });

    for (const filePath of drivePaths) {
      await writeTool.execute("sandbox-write-posix-drive", { path: filePath, content: "content" });
      await editTool.execute("sandbox-edit-posix-drive", {
        path: filePath,
        edits: [{ oldText: "before", newText: "after" }],
      });
    }

    expect(writtenPaths).toEqual(drivePaths);
    expect(editedPaths).toEqual(drivePaths);
  });
});
