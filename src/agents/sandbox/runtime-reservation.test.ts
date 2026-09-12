import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runExecProcess } from "../bash-tools.exec-runtime.js";
import { registerSandboxBackend } from "./backend.js";
import type {
  CreateSandboxBackendParams,
  CreateReservedSandboxBackendParamsV1,
  SandboxBackendFactory,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxContext } from "./context.js";
import { removeSandboxContainer } from "./manage.js";
import { SandboxRuntimeRetiredError } from "./provisioning-error.js";
import { maybePruneSandboxes } from "./prune.js";
import * as registry from "./registry.js";
import { readRegistry, readRegistryEntry, updateRegistry } from "./registry.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";

vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => undefined }));
vi.mock("../exec-defaults.js", () => ({ resolveNodeExecEligibility: () => ({ canExec: false }) }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let config: OpenClawConfig;
let workspaceDir: string;
let disposeBackend: (() => void) | undefined;
let nextId: number;
let pruneTimeMs = Date.now();

function advancePruneTime() {
  pruneTimeMs += 4 * 60 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(pruneTimeMs);
}

beforeEach(() => {
  const stateDir = tempDirs.make("sandbox-reservation-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  workspaceDir = path.join(stateDir, "workspace");
  nextId = 0;
  config = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "reserved-test",
          scope: "session",
          workspaceAccess: "rw",
          workspaceRoot: path.join(stateDir, "sandboxes"),
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
  };
});

afterEach(() => {
  disposeBackend?.();
  disposeBackend = undefined;
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function handle(params: CreateSandboxBackendParams) {
  if (!params.runtimeId || !params.assertRuntimeCurrent) {
    throw new Error("Provider allocation requires a durable runtime reservation.");
  }
  return {
    id: "reserved-test",
    runtimeId: params.runtimeId,
    runtimeLabel: params.runtimeId,
    configLabel: "provider-image",
    configLabelKind: "Provider",
    workdir: "/workspace",
    buildExecSpec: async () => {
      params.assertRuntimeCurrent?.();
      return { argv: ["synthetic"], env: {}, stdinMode: "pipe-closed" as const };
    },
    runShellCommand: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }),
  };
}

function install(factory: SandboxBackendFactory, removeRuntime = vi.fn(async () => {})) {
  disposeBackend = registerSandboxBackend("reserved-test", {
    reserveRuntimeId: () => `reserved-${++nextId}`,
    factory,
    manager: {
      describeRuntime: async () => ({ running: false, configLabelMatch: true }),
      removeRuntime,
    },
  });
  return removeRuntime;
}

function resolve() {
  return resolveSandboxContext({ config, sessionKey: "agent:test:reservation", workspaceDir });
}

async function seedLegacyRuntime() {
  const cfg = resolveSandboxConfigForAgent(config, "test");
  const { scopeKey } = resolveSandboxWorkspaceLayoutPaths({
    cfg,
    rawSessionKey: "agent:test:reservation",
    agentId: "test",
    workspaceDir,
  });
  await updateRegistry({
    containerName: "legacy-runtime",
    backendId: "reserved-test",
    sessionKey: scopeKey,
    image: "provider-image",
    createdAtMs: 1,
    lastUsedAtMs: 1,
  });
  return cfg;
}

describe("durable sandbox runtime generations", () => {
  it("replays a shared reservation from its original provider workspace", async () => {
    config.agents = {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        sandbox: { ...config.agents?.defaults?.sandbox, scope: "shared" },
      },
    };
    const originalWorkspace = workspaceDir;
    const factory = vi.fn(async (params: CreateSandboxBackendParams) => {
      if (params.workspaceDir !== originalWorkspace) {
        throw new Error("Provider repository owner changed");
      }
      return handle(params);
    });
    install(factory);
    const first = await resolve();
    workspaceDir = path.join(path.dirname(workspaceDir), "another-repository");
    const second = await resolveSandboxContext({
      config,
      sessionKey: "agent:another:shared-reservation",
      workspaceDir,
    });
    expect(second?.runtimeId).toBe(first?.runtimeId);
    expect(second?.workspaceDir).toBe(workspaceDir);
    expect(second?.agentWorkspaceDir).toBe(workspaceDir);
    expect(factory.mock.calls.map(([params]) => params.workspaceDir)).toEqual([
      originalWorkspace,
      originalWorkspace,
    ]);
  });

  it("rejects a prepared exec removed during supervisor admission and finalizes its artifacts", async () => {
    const marker = path.join(tempDirs.make("sandbox-admission-"), "spawned");
    const finalizeExec = vi.fn(async () => {});
    const token = {};
    install(async (params) => ({
      ...handle(params),
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
        ],
        env: process.env,
        stdinMode: "pipe-closed" as const,
        assertCurrent: params.assertRuntimeCurrent,
        finalizeToken: token,
      }),
      finalizeExec,
    }));
    const context = await resolve();
    const backend = context?.backend;
    if (!backend) {
      throw new Error("Expected the registered sandbox backend.");
    }
    const supervisor = getProcessSupervisor();
    const realSpawn = supervisor.spawn.bind(supervisor);
    vi.spyOn(supervisor, "spawn").mockImplementationOnce(async (input) => {
      await removeSandboxContainer("reserved-1");
      return realSpawn(input);
    });
    await expect(
      runExecProcess({
        command: "synthetic-command",
        workdir: process.cwd(),
        env: {},
        sandbox: {
          containerName: "reserved-1",
          workspaceDir,
          containerWorkdir: "/workspace",
          buildExecSpec: (params) => backend.buildExecSpec(params),
          finalizeExec,
        },
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        timeoutSec: null,
      }).then(async (run) => await run.promise),
    ).rejects.toThrow("removed or is being removed");
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
      token,
      status: "failed",
      exitCode: null,
      timedOut: false,
    });
  });

  it("retains pending cleanup origin and workspace so recreate can replay after a pre-submission failure", async () => {
    let configured = false;
    const allocated = new Set<string>();
    const cleaned: string[] = [];
    const manager: SandboxBackendManager = {
      describeRuntime: async () => ({ running: false, configLabelMatch: true }),
      removeRuntime: async ({ entry }) => {
        expect(entry.runtimeState).toBe("removing-pending");
        expect(entry.workspaceDir).toBe(workspaceDir);
        if (!configured) {
          throw new Error("provider config invalid");
        }
        // The provider adapter replays this exact unsubmitted request before release.
        allocated.add(entry.containerName);
        cleaned.push(entry.containerName);
        allocated.delete(entry.containerName);
      },
    };
    disposeBackend = registerSandboxBackend("reserved-test", {
      reserveRuntimeId: () => `reserved-${++nextId}`,
      factory: async (params: CreateReservedSandboxBackendParamsV1) => {
        if (!configured) {
          throw new Error("provider config invalid");
        }
        allocated.add(params.runtimeId);
        return handle(params);
      },
      manager,
    });
    await expect(resolve()).rejects.toThrow("provider config invalid");
    expect(allocated.size).toBe(0);
    await expect(removeSandboxContainer("reserved-1")).rejects.toThrow("provider config invalid");
    closeOpenClawStateDatabaseForTest();
    await expect(readRegistryEntry("reserved-1")).resolves.toMatchObject({
      runtimeState: "removing-pending",
      workspaceDir,
    });
    configured = true;
    await removeSandboxContainer("reserved-1");
    expect(cleaned).toEqual(["reserved-1"]);
    expect(allocated.size).toBe(0);
    await expect(readRegistryEntry("reserved-1")).resolves.toBeNull();
    await expect(resolve()).resolves.toMatchObject({ runtimeId: "reserved-2" });
  });

  it.each(["recreate", "prune"] as const)(
    "fences a legacy %s snapshot after concurrent adoption",
    async (operation) => {
      const cfg = await seedLegacyRuntime();
      const snapshot = await readRegistry();
      const started = createDeferred();
      const finish = createDeferred();
      const remove = install(async (params) => {
        const backend = handle(params);
        expect(backend.runtimeId).toBe("legacy-runtime");
        started.resolve();
        await finish.promise;
        return backend;
      });
      vi.spyOn(registry, "readRegistry").mockImplementationOnce(async () => {
        await started.promise;
        return snapshot;
      });
      if (operation === "prune") {
        advancePruneTime();
      }
      const removing =
        operation === "recreate"
          ? removeSandboxContainer("legacy-runtime")
          : maybePruneSandboxes({ ...cfg, prune: { idleHours: 1, maxAgeDays: 0 } });
      const creating = expect(resolve()).rejects.toThrow("removed or is being removed");
      await started.promise;
      try {
        await vi.waitFor(async () => {
          expect((await readRegistryEntry("legacy-runtime"))?.runtimeState).toBe(
            "removing-pending",
          );
        });
        expect(remove).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await Promise.allSettled([creating, removing]);
      }
      await creating;
      await removing;
      expect(remove).toHaveBeenCalledOnce();
      await expect(readRegistryEntry("legacy-runtime")).resolves.toBeNull();
    },
  );

  it("prevents adoption of a legacy runtime while provider removal is pending", async () => {
    await seedLegacyRuntime();
    const started = createDeferred();
    const finish = createDeferred();
    const factory = vi.fn(async (params: CreateSandboxBackendParams) => handle(params));
    install(
      factory,
      vi.fn(async () => {
        started.resolve();
        await finish.promise;
      }),
    );
    const removing = removeSandboxContainer("legacy-runtime");
    await started.promise;
    try {
      await expect(resolve()).rejects.toThrow("removed or is being removed");
      expect(factory).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await removing;
    }
  });

  it.each([
    { failure: "an uncertain provider response", error: new Error("provider response lost") },
    {
      failure: "an unrelated terminal signal",
      error: new SandboxRuntimeRetiredError("other-runtime"),
    },
  ])("retains the ID after $failure and database reopen", async ({ error }) => {
    const allocated: string[] = [];
    let fail = true;
    install(async (params) => {
      const backend = handle(params);
      await expect(readRegistryEntry(backend.runtimeId)).resolves.toMatchObject({
        runtimeState: "pending",
      });
      allocated.push(backend.runtimeId);
      if (fail) {
        throw error;
      }
      return backend;
    });
    await expect(resolve()).rejects.toThrow(error.message);
    closeOpenClawStateDatabaseForTest();
    fail = false;
    await expect(resolve()).resolves.toMatchObject({ runtimeId: "reserved-1" });
    expect(allocated).toEqual(["reserved-1", "reserved-1"]);
    await expect(readRegistryEntry("reserved-1")).resolves.toMatchObject({
      runtimeState: "ready",
      image: "provider-image",
      configLabelKind: "Provider",
    });
  });

  it("serializes concurrent creators onto one durable generation", async () => {
    const started = createDeferred();
    const finish = createDeferred();
    const runtimeIds: string[] = [];
    let active = 0;
    let maximumActive = 0;
    install(async (params) => {
      const backend = handle(params);
      active++;
      maximumActive = Math.max(maximumActive, active);
      runtimeIds.push(backend.runtimeId);
      started.resolve();
      await finish.promise;
      active--;
      return backend;
    });
    const first = resolve();
    await started.promise;
    const second = resolve();
    await vi.waitFor(() => expect(nextId).toBe(2));
    finish.resolve();
    const contexts = await Promise.all([first, second]);
    expect(contexts.map((context) => context?.runtimeId)).toEqual(["reserved-1", "reserved-1"]);
    expect(runtimeIds).toEqual(["reserved-1", "reserved-1"]);
    expect(maximumActive).toBe(1);
    expect((await readRegistry()).entries).toHaveLength(1);
  });

  it.each(["recreate", "prune"] as const)(
    "fences %s against in-flight provisioning before cleanup",
    async (operation) => {
      const started = createDeferred<string>();
      const finish = createDeferred();
      const remove = install(async (params) => {
        const backend = handle(params);
        started.resolve(backend.runtimeId);
        await finish.promise;
        return backend;
      });
      const creating = resolve();
      const failedCreation = expect(creating).rejects.toThrow("removed or is being removed");
      const id = await started.promise;
      let removing: Promise<void>;
      if (operation === "prune") {
        advancePruneTime();
        const cfg = resolveSandboxConfigForAgent(config, "test");
        removing = maybePruneSandboxes({ ...cfg, prune: { idleHours: 1, maxAgeDays: 0 } });
      } else {
        removing = removeSandboxContainer(id);
      }
      await vi.waitFor(async () => {
        expect((await readRegistryEntry(id))?.runtimeState).toBe("removing-pending");
      });
      expect(remove).not.toHaveBeenCalled();
      finish.resolve();
      await failedCreation;
      await removing;
      expect(remove).toHaveBeenCalledOnce();
      await expect(readRegistryEntry(id)).resolves.toBeNull();
      await expect(resolve()).resolves.toMatchObject({ runtimeId: "reserved-2" });
    },
  );

  it("revokes retained handles and preserves failed cleanup across restart", async () => {
    const remove = install(async (params) => handle(params));
    const context = await resolve();
    remove.mockRejectedValueOnce(new Error("cleanup response lost"));
    await expect(removeSandboxContainer("reserved-1")).rejects.toThrow("cleanup response lost");
    closeOpenClawStateDatabaseForTest();
    await expect(resolve()).rejects.toThrow("removed or is being removed");
    const backend = context?.backend;
    if (!backend) {
      throw new Error("Expected the resolved context to provide a sandbox backend.");
    }
    await expect(
      backend.buildExecSpec({ command: "true", env: {}, usePty: false }),
    ).rejects.toThrow("removed or is being removed");
    await expect(readRegistryEntry("reserved-1")).resolves.toMatchObject({
      runtimeState: "removing",
    });
    await removeSandboxContainer("reserved-1");
    await expect(resolve()).resolves.toMatchObject({ runtimeId: "reserved-3" });
  });

  it("replaces only an exact provider-confirmed terminal ID and retries at most once", async () => {
    const ids: string[] = [];
    install(async (params) => {
      const backend = handle(params);
      ids.push(backend.runtimeId);
      throw new SandboxRuntimeRetiredError(backend.runtimeId);
    });
    await expect(resolve()).rejects.toThrow("permanently released");
    expect(ids).toEqual(["reserved-1", "reserved-2"]);
    expect((await readRegistry()).entries).toEqual([]);
  });
});
