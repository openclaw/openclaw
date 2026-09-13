import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { resolveSandboxFileIdentity, SANDBOX_FILE_IDENTITY } from "./file-mutation-identity.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

const { defaultFsBridge } = vi.hoisted(() => ({ defaultFsBridge: vi.fn() }));
vi.mock("./fs-bridge.js", () => ({ createSandboxFsBridge: defaultFsBridge }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;

beforeEach(() => {
  vi.resetModules();
  stateDir = tempDirs.make("openclaw-prune-activity-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
});

afterEach(async () => {
  const { closeOpenClawStateDatabaseForTest } = await import("../../state/openclaw-state-db.js");
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("sandbox prune activity coordination", () => {
  it.each([
    { reserved: false, operation: "exec" },
    { reserved: true, operation: "exec" },
    { reserved: false, operation: "custom-fs" },
    { reserved: false, operation: "default-fs" },
  ])(
    "preserves $operation work and prunes after settlement (reserved: $reserved)",
    async ({ reserved, operation }) => {
      const { setRuntimeConfigSnapshot } = await import("../../config/config.js");
      const { resolveSandboxConfigForAgent } = await import("./config.js");
      const { createSandboxBackend, registerSandboxBackend } = await import("./backend.js");
      const { readRegistryEntry, updateRegistry } = await import("./registry.js");
      const { maybePruneSandboxes } = await import("./prune.js");
      const backendId = "test-prune-activity";
      const runtimeId = "old-active-runtime";
      const config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all" as const,
              backend: backendId,
              scope: "session" as const,
              prune: { idleHours: 24, maxAgeDays: 7 },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const cfg = resolveSandboxConfigForAgent(config);
      await updateRegistry({
        containerName: runtimeId,
        backendId,
        sessionKey: "agent:main:main",
        createdAtMs: Date.now() - 8 * 86_400_000,
        lastUsedAtMs: Date.now(),
        image: cfg.docker.image,
        ...(reserved ? { runtimeState: "ready" as const, workspaceDir: stateDir } : {}),
      });
      const rawHandle: SandboxBackendHandle = {
        id: backendId,
        runtimeId,
        runtimeLabel: runtimeId,
        workdir: stateDir,
        async buildExecSpec() {
          return { argv: ["true"], env: {}, stdinMode: "pipe-closed" };
        },
        async runShellCommand() {
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
        },
      };
      const started = createDeferredCore();
      const settled = createDeferredCore();
      class FileBridge implements SandboxFsBridge {
        private readonly physicalPath = "/workspace/physical";
        resolvePath() {
          return { relativePath: "alias", containerPath: "/workspace/alias" };
        }
        [SANDBOX_FILE_IDENTITY]() {
          return this.physicalPath;
        }
        async resolvePinnedMutationTarget() {
          return { policyPath: this.physicalPath, pinnedPath: this.physicalPath };
        }
        async readDirectory() {
          return [{ name: this.physicalPath, isDirectory: false }];
        }
        async readFile() {
          return Buffer.alloc(0);
        }
        async writeFile() {
          // No shell command is active while this filesystem operation awaits its next stage.
          started.resolve();
          await settled.promise;
        }
        async mkdirp() {}
        async remove() {}
        async rename() {}
        async stat() {
          return null;
        }
      }
      defaultFsBridge.mockImplementation(() => new FileBridge());
      if (operation === "custom-fs") {
        rawHandle.createFsBridge = () => new FileBridge();
      }
      const removeRuntime = vi.fn(async () => {});
      const factory = async () => rawHandle;
      const manager = {
        describeRuntime: async () => ({ running: true, configLabelMatch: true }),
        removeRuntime,
      };
      const restore = registerSandboxBackend(
        backendId,
        reserved ? { factory, manager, reserveRuntimeId: () => runtimeId } : { factory, manager },
      );
      try {
        const backend = await createSandboxBackend({
          sessionKey: "agent:main:main",
          scopeKey: "agent:main:main",
          cfg,
          workspaceDir: stateDir,
          agentWorkspaceDir: stateDir,
        });
        let release: () => Promise<void>;
        if (operation === "exec") {
          const exec = await backend.buildExecSpec({ command: "hold", env: {}, usePty: false });
          release = async () => {
            await backend.finalizeExec?.({
              status: "completed",
              exitCode: 0,
              timedOut: false,
              token: exec.finalizeToken,
            });
          };
        } else {
          const { createSandboxFsBridge } = await import("./fs-bridge.js");
          const bridgeParams = {
            sandbox: {
              workspaceDir: stateDir,
              agentWorkspaceDir: stateDir,
              workspaceAccess: "rw" as const,
              containerName: runtimeId,
              containerWorkdir: "/workspace",
              docker: cfg.docker,
              backend,
            },
          };
          const bridge =
            backend.createFsBridge?.(bridgeParams) ?? createSandboxFsBridge(bridgeParams);
          expect(await bridge.readDirectory?.({ filePath: "." })).toEqual([
            { name: "/workspace/physical", isDirectory: false },
          ]);
          expect(
            await bridge.resolvePinnedMutationTarget?.({ filePath: "alias", action: "write" }),
          ).toEqual({ policyPath: "/workspace/physical", pinnedPath: "/workspace/physical" });
          expect(await resolveSandboxFileIdentity({ bridge, filePath: "alias" })).toBe(
            "/workspace/physical",
          );
          const write = bridge.writeFile({ filePath: "alias", data: "content" });
          await started.promise;
          release = async () => {
            settled.resolve();
            await write;
          };
        }
        try {
          await maybePruneSandboxes(cfg);
          expect(removeRuntime).not.toHaveBeenCalled();
          expect(await readRegistryEntry(runtimeId)).not.toBeNull();
        } finally {
          await release();
        }
        vi.setSystemTime(Date.now() + 5 * 60_000);
        await maybePruneSandboxes(cfg);
        expect(removeRuntime).toHaveBeenCalledOnce();
        expect(await readRegistryEntry(runtimeId)).toBeNull();
        await expect(
          backend.buildExecSpec({ command: "stale", env: {}, usePty: false }),
        ).rejects.toThrow("was recycled");
      } finally {
        restore();
      }
    },
  );
});
