/**
 * Operator-hint tests for apply_patch workspace containment.
 * The remediation names configuration that relaxes containment, so it must reach the Gateway
 * log without entering the model-visible failure message, and must name the control that
 * actually imposed the boundary rather than one that cannot lift it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApplyPatchContainmentSource } from "./apply-patch-containment-hint.js";
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

async function hintForHostEscape(
  containmentSource: ApplyPatchContainmentSource | undefined,
): Promise<{ hint: string | undefined; message: string }> {
  return await withTempDir(async (dir) => {
    const root = path.join(dir, "workspace");
    await fs.mkdir(root, { recursive: true });
    const tool = createApplyPatchTool({ cwd: root, root, containmentSource });
    const error = await captureFailure(tool, addFilePatch(path.join(dir, "outside", "note.md")));
    return { hint: readToolOperatorHint(error), message: (error as Error).message };
  });
}

describe("apply_patch workspace containment hint", () => {
  it("names both configuration settings when configuration imposed the boundary", async () => {
    const { hint, message } = await hintForHostEscape("config");

    expect(hint).toBeDefined();
    expect(hint).toContain("tools.exec.applyPatch.workspaceOnly");
    expect(hint).toContain("tools.fs.workspaceOnly");
    // The model sees only the boundary rejection, never the way to lift it.
    expect(message).toContain("Path escapes sandbox root");
    expect(message).not.toContain("workspaceOnly");
  });

  it("points a worker placement at the session mode, not at settings it never reads", async () => {
    const { hint } = await hintForHostEscape("worker");

    expect(hint).toContain("full session permission mode");
    expect(hint).toContain("do not read");
  });

  it("points a mode-governed session at the mode, not at configuration", async () => {
    const { hint } = await hintForHostEscape("session");

    expect(hint).toContain("full permission mode");
    expect(hint).not.toContain("tools.exec.applyPatch.workspaceOnly");
  });

  it("stays silent when the runtime owner named no containment source", async () => {
    const { hint } = await hintForHostEscape(undefined);

    expect(hint).toBeUndefined();
  });

  it("leaves unrelated apply_patch failures unhinted", async () => {
    await withTempDir(async (dir) => {
      const tool = createApplyPatchTool({ cwd: dir, root: dir, containmentSource: "config" });
      const error = await captureFailure(tool, "*** Begin Patch\nnot a real hunk\n*** End Patch");

      expect(readToolOperatorHint(error)).toBeUndefined();
    });
  });

  it("hints a sandboxed run whose mounted host path fails the host workspace check", async () => {
    // resolvePatchPath still applies the host check when the bridge exposes a hostPath, so
    // this rejection is one the host controls do govern.
    const sandbox = createMemoryPatchSandbox();
    const tool = createApplyPatchTool({
      cwd: "/local/workspace",
      root: "/local/workspace",
      containmentSource: "config",
      sandbox: {
        root: "/local/workspace",
        bridge: {
          ...sandbox.bridge,
          resolvePath: ({ filePath }: { filePath: string }) => ({
            relativePath: filePath,
            containerPath: `/sandbox/${filePath}`,
            hostPath: "/etc/escaped.md",
          }),
        },
      },
    });
    const error = await captureFailure(tool, addFilePatch("escaped.md"));

    expect(isHostRootEscapeError(error)).toBe(true);
    expect(readToolOperatorHint(error)).toContain("tools.exec.applyPatch.workspaceOnly");
  });

  it("leaves a bridge's own mount rejection to the bridge's remedy", async () => {
    // Bridges enforce their own mount boundary and never tag the host marker. Host controls
    // cannot lift a mount, so this rejection must carry no host hint. OpenShell's bridge
    // phrases this identically to the host message, so the tag is what separates them.
    const sandbox = createMemoryPatchSandbox();
    const tool = createApplyPatchTool({
      cwd: "/local/workspace",
      root: "/local/workspace",
      containmentSource: "config",
      sandbox: {
        root: "/local/workspace",
        bridge: {
          ...sandbox.bridge,
          resolvePath: () => {
            throw new Error("Path escapes sandbox root (/local/workspace): escaped.md");
          },
        },
      },
    });
    const error = await captureFailure(tool, addFilePatch("escaped.md"));

    expect((error as Error).message).toContain("Path escapes sandbox root");
    expect(isHostRootEscapeError(error)).toBe(false);
    expect(readToolOperatorHint(error)).toBeUndefined();
  });

  it("hints host admission failures for declared sandbox workspace mappings", async () => {
    const sandbox = createMemoryPatchSandbox();
    const tool = createApplyPatchTool({
      ...sandbox.options,
      containmentSource: "config",
      sandbox: {
        ...sandbox.options.sandbox,
        bridge: { ...sandbox.bridge, pathMappings: [] },
        workspaceMounts: [],
      },
    });
    const error = await captureFailure(tool, addFilePatch("escaped.md"));

    expect(error).toMatchObject({
      message: "Path escapes sandbox root (/local/workspace): escaped.md",
    });
    expect(readToolOperatorHint(error)).toContain("workspace-contained by configuration");
    expect(sandbox.createFileExclusive).not.toHaveBeenCalled();
    expect(sandbox.files.size).toBe(0);
  });

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

  it("never masks a failure that cannot carry a hint", () => {
    const frozen = Object.freeze(new Error("Path escapes sandbox root (/w): /outside/note.md"));

    expect(() => withToolOperatorHint(frozen, "hint")).not.toThrow();
    expect(withToolOperatorHint(frozen, "hint")).toBe(frozen);
    expect(readToolOperatorHint(frozen)).toBeUndefined();
  });

  it("keeps the first hint when one is already attached", () => {
    const error = new Error("Path escapes sandbox root (/w): /outside/note.md");
    withToolOperatorHint(error, "first");
    withToolOperatorHint(error, "second");

    expect(readToolOperatorHint(error)).toBe("first");
  });
});
