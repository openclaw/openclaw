import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { runExecProcess } from "../bash-tools.exec-runtime.js";
import { registerSandboxBackend } from "./backend.js";
import type {
  CreateSandboxBackendParams,
  CreateReservedSandboxBackendParamsV1,
  ReservedSandboxBackendFactoryV1,
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
// mock-isolation: Runtime-reservation tests keep skill eligibility independent of host approval storage.
vi.mock("../exec-defaults.js", () => ({
  resolveNodeExecEligibilityAsync: () => ({ canExec: false }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    disposeBackend?.();
    disposeBackend = undefined;
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
let config: OpenClawConfig;
let workspaceDir: string;
let disposeBackend: (() => void) | undefined;
let nextId: number;
let pruneTimeMs = Date.now();

function pruneImmediately() {
  pruneTimeMs += 4 * 60 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(pruneTimeMs);
  const result = structuredClone(config);
  result.agents!.defaults!.sandbox!.prune = { idleHours: 1, maxAgeDays: 0 };
  return maybePruneSandboxes(result);
}

beforeEach(() => {
  const stateDir = tempDirs.make("sandbox-reservation-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  workspaceDir = path.join(stateDir, "workspace");
  nextId = 0;
  const sandbox = {
    mode: "all",
    backend: "reserved-test",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: path.join(stateDir, "sandboxes"),
    prune: { idleHours: 0, maxAgeDays: 0 },
  } satisfies NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["sandbox"];
  config = { agents: { defaults: { sandbox } } };
  setRuntimeConfigSnapshot(config);
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

function install(
  factory: ReservedSandboxBackendFactoryV1 = async (params) => handle(params),
  removeRuntime = vi.fn<SandboxBackendManager["removeRuntime"]>(async () => {}),
) {
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

async function resolveBackend() {
  const backend = (await resolve())?.backend;
  if (!backend) {
    throw new Error("Expected the resolved sandbox backend.");
  }
  return backend;
}

function observeRemovalIntent() {
  const accepted = createDeferred();
  probe.command(stateWorker, async (command, executeOptions, scope) => {
    const result = await scope.execute(command, executeOptions);
    if (command.type === "sandboxRegistry.beginRemoval") {
      accepted.resolve();
    }
    return result;
  });
  return accepted.promise;
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
}

describe("durable sandbox runtime generations", () => {
  it("rejects hosted custody released during reserved backend discovery before allocation", async () => {
    const owner = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        processNamespace: readGatewayLockProcessNamespace(),
        createdAt: new Date().toISOString(),
        configPath: path.join(workspaceDir, "openclaw.json"),
        role: "gateway",
      },
    });
    const entered = createDeferred();
    const resume = createDeferred();
    const allocate = vi.fn();
    install(async (params) => {
      entered.resolve();
      await resume.promise;
      params.assertRuntimeCurrent?.();
      allocate();
      return handle(params);
    });
    const preparation = resolve();
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        preparation,
        "Backend discovery not reached",
      );
      owner.release();
      resume.resolve();
      const error = await preparation.catch((failure: unknown) => failure);
      expect(allocate).not.toHaveBeenCalled();
      expect(error).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      expect((await readRegistry()).entries).toEqual([
        expect.objectContaining({ runtimeState: "pending" }),
      ]);
    } finally {
      resume.resolve();
      await preparation.catch(() => {});
      owner.release();
    }
  });

  it("replays a shared reservation from its original provider workspace", async () => {
    config.agents!.defaults!.sandbox!.scope = "shared";
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
    expect(second).toMatchObject({
      runtimeId: first?.runtimeId,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    });
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
    const backend = await resolveBackend();
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
    install(
      async (params) => {
        if (!configured) {
          throw new Error("provider config invalid");
        }
        const backend = handle(params);
        allocated.add(backend.runtimeId);
        return backend;
      },
      vi.fn<SandboxBackendManager["removeRuntime"]>(async ({ entry }) => {
        expect(entry).toMatchObject({ runtimeState: "removing-pending", workspaceDir });
        if (!configured) {
          throw new Error("provider config invalid");
        }
        // The provider adapter replays this exact unsubmitted request before release.
        allocated.add(entry.containerName);
        cleaned.push(entry.containerName);
        allocated.delete(entry.containerName);
      }),
    );
    await expect(resolve()).rejects.toThrow("provider config invalid");
    expect(allocated.size).toBe(0);
    await expect(removeSandboxContainer("reserved-1")).rejects.toThrow("provider config invalid");
    await closeStateDatabaseForTest();
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

  it.each([
    { operation: "recreate", legacy: true },
    { operation: "prune", legacy: true },
    { operation: "recreate", legacy: false },
    { operation: "prune", legacy: false },
  ])("fences $operation against provisioning (legacy=$legacy)", async ({ operation, legacy }) => {
    if (legacy) {
      await seedLegacyRuntime();
    }
    const started = createDeferred<string>();
    const finish = createDeferred();
    const remove = install(async (params) => {
      const backend = handle(params);
      started.resolve(backend.runtimeId);
      await finish.promise;
      return backend;
    });
    if (legacy) {
      const snapshot = await readRegistry();
      vi.spyOn(registry, "readRegistry").mockImplementationOnce(async () => {
        await started.promise;
        return snapshot;
      });
    }
    const startRemoval = (id: string) =>
      operation === "prune" ? pruneImmediately() : removeSandboxContainer(id);
    const intent = observeRemovalIntent();
    const legacyRemoval = legacy ? startRemoval("legacy-runtime") : undefined;
    const creating = expect(resolve()).rejects.toThrow("removed or is being removed");
    const id = await started.promise;
    if (legacy) {
      expect(id).toBe("legacy-runtime");
    }
    const removing = legacyRemoval ?? startRemoval(id);
    try {
      await awaitGateBeforeSettlement(intent, removing, "Removal intent was not acknowledged");
      await expect(readRegistryEntry(id)).resolves.toMatchObject({
        runtimeState: "removing-pending",
      });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await Promise.allSettled([creating, removing]);
    }
    await creating;
    await removing;
    expect(remove).toHaveBeenCalledOnce();
    await expect(readRegistryEntry(id)).resolves.toBeNull();
    if (!legacy) {
      await expect(resolve()).resolves.toMatchObject({ runtimeId: "reserved-2" });
    }
  });

  it("prevents adoption of a legacy runtime while provider removal is pending", async () => {
    await seedLegacyRuntime();
    const started = createDeferred();
    const finish = createDeferred();
    const factory = vi.fn(async (params: CreateSandboxBackendParams) => handle(params));
    install(
      factory,
      vi.fn<SandboxBackendManager["removeRuntime"]>(async () => {
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
    await closeStateDatabaseForTest();
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
    const secondReservation = createDeferred();
    const finish = createDeferred();
    const runtimeIds: string[] = [];
    let active = 0;
    let maximumActive = 0;
    disposeBackend = registerSandboxBackend("reserved-test", {
      reserveRuntimeId: () => {
        const id = `reserved-${++nextId}`;
        if (nextId === 2) {
          secondReservation.resolve();
        }
        return id;
      },
      factory: async (params: CreateReservedSandboxBackendParamsV1) => {
        const backend = handle(params);
        active++;
        maximumActive = Math.max(maximumActive, active);
        runtimeIds.push(backend.runtimeId);
        started.resolve();
        await finish.promise;
        active--;
        return backend;
      },
    });
    const first = resolve();
    let second: ReturnType<typeof resolve> | undefined;
    try {
      await awaitGateBeforeSettlement(started.promise, first, "First creator did not start");
      second = resolve();
      await awaitGateBeforeSettlement(
        secondReservation.promise,
        second,
        "Second creator did not reserve a runtime",
      );
      expect(nextId).toBe(2);
      finish.resolve();
      const contexts = await Promise.all([first, second]);
      expect(contexts.map((context) => context?.runtimeId)).toEqual(["reserved-1", "reserved-1"]);
      expect(runtimeIds).toEqual(["reserved-1", "reserved-1"]);
      expect(maximumActive).toBe(1);
      expect((await readRegistry()).entries).toHaveLength(1);
    } finally {
      finish.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("revokes retained handles and preserves failed cleanup across restart", async () => {
    const remove = install();
    const backend = await resolveBackend();
    remove.mockRejectedValueOnce(new Error("cleanup response lost"));
    await expect(removeSandboxContainer("reserved-1")).rejects.toThrow("cleanup response lost");
    await closeStateDatabaseForTest();
    await expect(resolve()).rejects.toThrow("removed or is being removed");
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
