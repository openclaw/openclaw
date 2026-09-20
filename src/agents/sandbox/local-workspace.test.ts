import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runCommandBuffered } from "../../process/exec.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { bindLocalSandboxWorkspace } from "./local-workspace.js";
import { createSandboxTestContext } from "./test-fixtures.js";

it.runIf(process.platform !== "win32")(
  "keeps real bridge reads, path identity, and writes while checkpointing mutations",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bound-local-bridge-"));
    let revoked = false;
    let revokeDuringBuild = false;
    const checkpoint = vi.fn(async () => {});
    const finalized = vi.fn(async () => {});
    const backend: SandboxBackendHandle = {
      id: "local-test",
      runtimeId: "local-test",
      runtimeLabel: "local-test",
      workdir: root,
      buildExecSpec: async () => {
        if (revokeDuringBuild) {
          revoked = true;
        }
        return { argv: ["true"], env: {}, stdinMode: "pipe-closed", finalizeToken: "prepared" };
      },
      finalizeExec: finalized,
      runShellCommand: async (params) => {
        const result = await runCommandBuffered(
          ["sh", "-c", params.script, "sandbox-test", ...(params.args ?? [])],
          {
            input: params.stdin,
            signal: params.signal,
            timeoutMs: 10000,
          },
        );
        if (result.code !== 0 && !params.allowFailure) {
          throw new Error(result.stderr.toString());
        }
        return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    };
    const sandbox = createSandboxTestContext({
      overrides: { workspaceDir: root, agentWorkspaceDir: root, containerWorkdir: root, backend },
    });
    const bridge = createSandboxFsBridge({ sandbox });
    sandbox.fsBridge = bridge;
    try {
      bindLocalSandboxWorkspace(sandbox, {
        workspaceDir: root,
        workspaceCwd: root,
        checkpoint,
        provision: async (run) => await run(),
        assertCurrent: () => {
          if (revoked) {
            throw new Error("revoked");
          }
        },
      });
      await sandbox.fsBridge.writeFile({ filePath: "note.txt", data: "bound write" });
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(sandbox.fsBridge.resolvePath({ filePath: "note.txt" }).hostPath).toBe(
        path.join(root, "note.txt"),
      );
      expect((await sandbox.fsBridge.readFile({ filePath: "note.txt" })).toString()).toBe(
        "bound write",
      );
      expect(sandbox.fsBridge.pathMappings?.length).toBeGreaterThan(0);
      const spec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
      revoked = true;
      expect(() => spec.assertCurrent?.()).toThrow("revoked");
      await expect(
        sandbox.fsBridge.writeFile({ filePath: "blocked.txt", data: "no" }),
      ).rejects.toThrow("revoked");
      await expect(fs.stat(path.join(root, "blocked.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      revoked = false;
      await backend.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false });
      expect(finalized).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalledTimes(2);
      revokeDuringBuild = true;
      await expect(
        backend.buildExecSpec({ command: "true", env: {}, usePty: false }),
      ).rejects.toThrow("revoked");
      expect(finalized).toHaveBeenLastCalledWith({
        status: "failed",
        exitCode: null,
        timedOut: false,
        token: "prepared",
      });
      expect(checkpoint).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform !== "win32")(
  "rejects a filesystem mutation when authority closes during path preparation",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bound-revocation-"));
    let current = true;
    let observedPreparation = false;
    const backend: SandboxBackendHandle = {
      id: "local-test",
      runtimeId: "local-test",
      runtimeLabel: "local-test",
      workdir: root,
      buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
      runShellCommand: async (params) => {
        const result = await runCommandBuffered(
          ["sh", "-c", params.script, "sandbox-test", ...(params.args ?? [])],
          {
            input: params.stdin,
            signal: params.signal,
            timeoutMs: 10000,
          },
        );
        if (params.stdin === undefined) {
          observedPreparation = true;
          current = false;
        }
        if (result.code !== 0 && !params.allowFailure) {
          throw new Error(result.stderr.toString());
        }
        return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    };
    const sandbox = createSandboxTestContext({
      overrides: { workspaceDir: root, agentWorkspaceDir: root, containerWorkdir: root, backend },
    });
    sandbox.fsBridge = createSandboxFsBridge({ sandbox });
    bindLocalSandboxWorkspace(sandbox, {
      workspaceDir: root,
      workspaceCwd: root,
      provision: async (run) => await run(),
      checkpoint: async () => {},
      assertCurrent: () => {
        if (!current) {
          throw new Error("revoked during preparation");
        }
      },
    });
    try {
      await expect(
        sandbox.fsBridge.writeFile({ filePath: "late.txt", data: "must not write" }),
      ).rejects.toThrow("revoked during preparation");
      expect(observedPreparation).toBe(true);
      await expect(fs.stat(path.join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
