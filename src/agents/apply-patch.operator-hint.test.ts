import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryPatchSandbox } from "./apply-patch.test-support.js";
import { isHostRootEscapeError } from "./sandbox-paths.js";
import { readToolOperatorHint, withToolOperatorHint } from "./tool-operator-hint.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  // realpath: containment compares canonical paths, and macOS os.tmpdir() is a
  // /var -> /private/var symlink that would otherwise trip the guard itself.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-hint-")));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function addFilePatch(target: string): string {
  return `*** Begin Patch\n*** Add File: ${target}\n+escaped\n*** End Patch`;
}

async function captureFailure(
  tool: ReturnType<typeof createApplyPatchTool>,
  input: string,
): Promise<unknown> {
  try {
    await tool.execute("call-hint", { input }, undefined);
  } catch (error) {
    return error;
  }
  throw new Error("expected apply_patch to reject");
}

describe("apply_patch workspace containment hint", () => {
  it.each(["config", "session", undefined, "invalid patch"] as const)(
    "hints only the governing containment source: %s",
    async (source) => {
      await withTempDir(async (dir) => {
        const root = path.join(dir, "workspace");
        await fs.mkdir(root);
        const tool = createApplyPatchTool({
          cwd: root,
          root,
          containmentSource: source === "invalid patch" ? "config" : source,
        });
        const error = await captureFailure(
          tool,
          source === "invalid patch"
            ? "*** Begin Patch\nnot a real hunk\n*** End Patch"
            : addFilePatch(path.join(dir, "outside", "note.md")),
        );
        const hint = readToolOperatorHint(error);
        if (source === "config") {
          expect(hint).toBeDefined();
          expect(hint).toContain("tools.exec.applyPatch.workspaceOnly");
          expect(hint).toContain("tools.fs.workspaceOnly");
          // The model sees the rejection, never the way to lift it.
          expect(error).toMatchObject({
            message: expect.stringContaining("Path escapes sandbox root"),
          });
          expect(error).not.toMatchObject({ message: expect.stringContaining("workspaceOnly") });
        } else if (source === "session") {
          expect(hint).toContain("full permission mode");
          expect(hint).not.toContain("tools.exec.applyPatch.workspaceOnly");
        } else {
          expect(hint).toBeUndefined();
        }
      });
    },
  );

  it.each(["host path", "bridge", "declared mapping"] as const)(
    "distinguishes the sandbox rejection owner: %s",
    async (boundary) => {
      const sandbox = createMemoryPatchSandbox();
      const bridge = { ...sandbox.bridge };
      if (boundary === "declared mapping") {
        bridge.pathMappings = [];
      } else {
        bridge.resolvePath = ({ filePath }) => {
          // A bridge can use the same wording without the host-owned escape marker.
          if (boundary === "bridge") {
            throw new Error("Path escapes sandbox root (/local/workspace): escaped.md");
          }
          return {
            relativePath: filePath,
            containerPath: `/sandbox/${filePath}`,
            hostPath: "/etc/escaped.md",
          };
        };
      }
      const tool = createApplyPatchTool({
        ...sandbox.options,
        containmentSource: "config",
        sandbox: { ...sandbox.options.sandbox, bridge, workspaceMounts: [] },
      });
      const error = await captureFailure(tool, addFilePatch("escaped.md"));
      expect(isHostRootEscapeError(error)).toBe(boundary !== "bridge");
      if (boundary === "bridge") {
        expect(error).toMatchObject({
          message: expect.stringContaining("Path escapes sandbox root"),
        });
        expect(readToolOperatorHint(error)).toBeUndefined();
      } else {
        expect(readToolOperatorHint(error)).toContain("tools.exec.applyPatch.workspaceOnly");
        if (boundary === "declared mapping") {
          expect(error).toMatchObject({
            message: "Path escapes sandbox root (/local/workspace): escaped.md",
          });
          expect(readToolOperatorHint(error)).toContain("workspace-contained by configuration");
          expect(sandbox.createFileExclusive).not.toHaveBeenCalled();
          expect(sandbox.files.size).toBe(0);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "hints host symlink escapes without treating in-root hardlinks as escapes",
    async () => {
      await withTempDir(async (dir) => {
        const root = path.join(dir, "workspace");
        const outside = path.join(dir, "outside");
        await fs.mkdir(root);
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "note.md"), "original\n");
        const link = path.join(root, "link");
        await fs.symlink(outside, link, "dir");
        const tool = createApplyPatchTool({ cwd: root, containmentSource: "config" });
        const update = (target: string) =>
          `*** Begin Patch\n*** Update File: ${target}\n@@\n-original\n+changed\n*** End Patch`;
        const escaped = await captureFailure(tool, update("link/note.md"));

        expect(escaped).toMatchObject({
          message: `Symlink escapes sandbox root (${root}): ${link}`,
        });
        expect(readToolOperatorHint(escaped)).toContain("workspace-contained by configuration");
        await expect(fs.readFile(path.join(outside, "note.md"), "utf8")).resolves.toBe(
          "original\n",
        );

        await fs.writeFile(path.join(root, "source.md"), "original\n");
        await fs.link(path.join(root, "source.md"), path.join(root, "linked.md"));
        const hardlink = await captureFailure(tool, update("linked.md"));
        expect(hardlink).toMatchObject({ message: expect.stringMatching(/hardlink/i) });
        expect(readToolOperatorHint(hardlink)).toBeUndefined();
        await expect(fs.readFile(path.join(root, "source.md"), "utf8")).resolves.toBe("original\n");
      });
    },
  );

  it.runIf(process.platform !== "win32").each(["delete", "provenance read"] as const)(
    "keeps the containment hint when a parent changes before %s",
    async (operation) => {
      await withTempDir(async (dir) => {
        const root = path.join(dir, "workspace");
        const parent = path.join(root, "parent");
        const movedParent = path.join(root, "original-parent");
        const outside = path.join(dir, "outside");
        await fs.mkdir(parent, { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(path.join(parent, "victim.txt"), "inside\n");
        await fs.writeFile(path.join(outside, "victim.txt"), "outside\n");
        const clearAfterDelete = vi.fn();
        const tool = createApplyPatchTool({
          cwd: root,
          containmentSource: "config",
          memoryWriteProvenance: {
            classifies: async () => {
              await fs.rename(parent, movedParent);
              await fs.symlink(outside, parent, "dir");
              return operation === "provenance read";
            },
            write: vi.fn(),
            clearAfterDelete,
          },
        });
        const error = await captureFailure(
          tool,
          operation === "delete"
            ? "*** Begin Patch\n*** Delete File: parent/victim.txt\n*** End Patch"
            : "*** Begin Patch\n*** Update File: parent/victim.txt\n@@\n-inside\n+changed\n*** End Patch",
        );

        expect(error).toMatchObject({
          message:
            operation === "delete"
              ? "path alias escape blocked"
              : `Failed boundary read for ${path.join(parent, "victim.txt")} (unsafe path)`,
        });
        expect(isHostRootEscapeError(error)).toBe(true);
        expect(readToolOperatorHint(error)).toContain("workspace-contained by configuration");
        expect(clearAfterDelete).not.toHaveBeenCalled();
        await expect(fs.readFile(path.join(outside, "victim.txt"), "utf8")).resolves.toBe(
          "outside\n",
        );
        await expect(fs.readFile(path.join(movedParent, "victim.txt"), "utf8")).resolves.toBe(
          "inside\n",
        );
      });
    },
  );

  it.each([false, true])("preserves the first failure and hint (frozen=%s)", (frozen) => {
    const error = new Error("Path escapes sandbox root (/w): /outside/note.md");
    if (frozen) {
      Object.freeze(error);
    }
    expect(() => withToolOperatorHint(error, "first")).not.toThrow();
    expect(withToolOperatorHint(error, "first")).toBe(error);
    withToolOperatorHint(error, "second");
    expect(readToolOperatorHint(error)).toBe(frozen ? undefined : "first");
  });
});
