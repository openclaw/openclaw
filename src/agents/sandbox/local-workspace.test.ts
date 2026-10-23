import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../../process/exec.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import {
  bindSandboxInputStager,
  createSandboxInputStager,
  getSandboxInputStager,
} from "./input-staging.js";
import { bindLocalSandboxWorkspace } from "./local-workspace.js";
import { createSandboxTestContext } from "./test-fixtures.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const execParams = { command: "true", env: {}, usePty: false };
function createLocalSandbox(
  root: string,
  assertCurrent: () => void,
  overrides: Partial<SandboxBackendHandle> = {},
  afterShell: (params: Parameters<SandboxBackendHandle["runShellCommand"]>[0]) => void = () => {},
) {
  const backend: SandboxBackendHandle = {
    id: "local-test",
    runtimeId: "local-test",
    runtimeLabel: "local-test",
    workdir: root,
    buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async (params) => {
      const result = await runCommandBuffered(
        ["sh", "-c", params.script, "sandbox-test", ...(params.args ?? [])],
        { input: params.stdin, signal: params.signal, timeoutMs: 10000 },
      );
      afterShell(params);
      if (result.code !== 0 && !params.allowFailure) {
        throw new Error(result.stderr.toString());
      }
      return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    ...overrides,
  };
  const sandbox = {
    ...createSandboxTestContext({
      overrides: { workspaceDir: root, agentWorkspaceDir: root, containerWorkdir: root, backend },
    }),
    backend,
  };
  const bridge = createSandboxFsBridge({ sandbox });
  sandbox.fsBridge = bridge;
  const bind = (projection: Partial<Parameters<typeof bindLocalSandboxWorkspace>[1]> = {}) =>
    bindLocalSandboxWorkspace(sandbox, {
      [Symbol.dispose]() {},
      workspaceDir: root,
      workspaceCwd: root,
      checkpoint: async () => {},
      terminate: async (run) => await run(),
      retain: () => {
        assertCurrent();
        return () => {};
      },
      provision: async (run) => await run(),
      assertCurrent,
      ...projection,
    });
  return { backend, bridge, bind };
}

const finalization = (status: "completed" | "failed", token: unknown) => ({
  status,
  exitCode: status === "completed" ? 0 : null,
  timedOut: false,
  token,
});

it.runIf(process.platform !== "win32")(
  "keeps real bridge reads, path identity, and writes while checkpointing mutations",
  async () => {
    const root = dirs.make("openclaw-bound-local-bridge-");
    let authority = new AbortController();
    let revokeDuringBuild = false;
    let waitForAdmission: Promise<void> | undefined;
    const checkpoint = vi.fn(async () => {});
    const finalized = vi.fn(async () => {});
    const assertCurrent = () => authority.signal.throwIfAborted();
    const { backend, bridge, bind } = createLocalSandbox(root, assertCurrent, {
      buildExecSpec: async () => {
        if (revokeDuringBuild) {
          authority.abort(new Error("revoked"));
        }
        return { argv: ["true"], env: {}, stdinMode: "pipe-closed", finalizeToken: "prepared" };
      },
      finalizeExec: finalized,
    });
    bindSandboxInputStager(bridge, createSandboxInputStager({ root, bridge, assertCurrent }));
    bind({
      checkpoint,
      provision: async (run) => {
        await waitForAdmission;
        return await run();
      },
    });
    await bridge.writeFile({ filePath: "note.txt", data: "bound write" });
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(bridge.resolvePath({ filePath: "note.txt" }).hostPath).toBe(path.join(root, "note.txt"));
    expect((await bridge.readFile({ filePath: "note.txt" })).toString()).toBe("bound write");
    expect(bridge.pathMappings?.length).toBeGreaterThan(0);
    const spec = await backend.buildExecSpec(execParams);
    authority.abort(new Error("revoked"));
    expect(() => spec.assertCurrent?.()).toThrow("revoked");
    await expect(bridge.writeFile({ filePath: "blocked.txt", data: "no" })).rejects.toThrow(
      "revoked",
    );
    await expect(fs.stat(path.join(root, "blocked.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    authority = new AbortController();
    await backend.finalizeExec?.(finalization("completed", spec.finalizeToken));
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(finalization("completed", "prepared"));
    expect(checkpoint).toHaveBeenCalledTimes(2);
    revokeDuringBuild = true;
    await expect(backend.buildExecSpec(execParams)).rejects.toThrow("revoked");
    expect(finalized).toHaveBeenLastCalledWith(finalization("failed", "prepared"));
    expect(checkpoint).toHaveBeenCalledTimes(2);
    revokeDuringBuild = false;
    authority = new AbortController();
    const rejectAfterAdmission = async (start: () => Promise<unknown>[]) => {
      const admission = createDeferred();
      waitForAdmission = admission.promise;
      const pending = start();
      authority.abort(new Error("revoked"));
      admission.resolve();
      for (const operation of pending) {
        await expect(operation).rejects.toThrow("revoked");
      }
    };
    await rejectAfterAdmission(() => [
      backend.runShellCommand({ script: `touch "${root}/blocked.txt"` }),
      backend.buildExecSpec(execParams),
    ]);
    await expect(fs.stat(path.join(root, "blocked.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    authority = new AbortController();
    waitForAdmission = undefined;
    const stage = getSandboxInputStager(bridge)!;
    const stageInput = (prefix: string, content: string) =>
      stage({ prefix, content, assertCurrent: () => {} });
    const checkpointsBeforeInput = checkpoint.mock.calls.length;
    const staged = await stageInput("fetched-input", "trusted input");
    expect(await fs.readFile(staged, "utf8")).toBe("trusted input");
    expect(checkpoint).toHaveBeenCalledTimes(checkpointsBeforeInput + 1);
    const before = await fs.readdir(path.dirname(path.dirname(staged)));
    await rejectAfterAdmission(() => [stageInput("late-input", "blocked")]);
    expect(await fs.readdir(path.dirname(path.dirname(staged)))).toEqual(before);
  },
);

it.runIf(process.platform !== "win32")(
  "rejects a filesystem mutation when authority closes during path preparation",
  async () => {
    const root = dirs.make("openclaw-bound-revocation-");
    const authority = new AbortController();
    const assertCurrent = () => authority.signal.throwIfAborted();
    const { bridge, bind } = createLocalSandbox(root, assertCurrent, {}, (params) => {
      if (params.stdin === undefined) {
        authority.abort(new Error("revoked during preparation"));
      }
    });
    bind();
    await expect(
      bridge.writeFile({ filePath: "late.txt", data: "must not write" }),
    ).rejects.toThrow("revoked during preparation");
    await expect(fs.stat(path.join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
