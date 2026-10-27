import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { runExecProcess } from "../bash-tools.exec-runtime.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
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
import { acquireSandboxGatewayOwner, useSandboxRegistryState } from "./registry.test-support.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";

vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => undefined }));
// mock-isolation: Runtime-reservation tests keep skill eligibility independent of host approval storage.
vi.mock("../exec-defaults.js", () => ({
  resolveNodeExecEligibilityAsync: () => ({ canExec: false }),
}));

const state = useSandboxRegistryState("sandbox-reservation-", () => {
  disposeBackend?.();
  disposeBackend = undefined;
});
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
  const stateDir = state.root;
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

const expectRuntime = (name: string, expected: Partial<registry.SandboxRegistryEntry>) =>
  expect(readRegistryEntry(name)).resolves.toMatchObject(expected);
const expectAbsent = (name: string) => expect(readRegistryEntry(name)).resolves.toBeNull();
const expectResolvedId = (runtimeId: string) =>
  expect(resolve()).resolves.toMatchObject({ runtimeId });

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
  it("keeps an expired runtime while a turn holds it, then prunes after release", async () => {
    const remove = install();
    const sandbox = await resolve();
    try {
      await pruneImmediately();
      expect(remove).not.toHaveBeenCalled();
      await expectRuntime("reserved-1", { runtimeState: "ready" });
    } finally {
      sandbox?.[Symbol.dispose]?.();
    }
    await pruneImmediately();
    expect(remove).toHaveBeenCalledOnce();
    await expectAbsent("reserved-1");
  });

  it("waits only for the runtime slot whose pruning already started", async () => {
    await seedLegacyRuntime();
    const removal = createEnteredGate();
    install(
      undefined,
      vi.fn(async () => removal.wait()),
    );
    const pruning = pruneImmediately();
    await awaitGateBeforeSettlement(removal.entered, pruning, "Prune did not remove the runtime");
    let settled = false;
    const waiting = resolve().then((context) => {
      settled = true;
      return context;
    });
    try {
      const unrelated = await resolveSandboxContext({
        config,
        workspaceDir,
        sessionKey: "agent:test:unrelated",
      });
      try {
        expect(unrelated?.runtimeId).toBe("reserved-1");
        expect(settled).toBe(false);
      } finally {
        unrelated?.[Symbol.dispose]?.();
      }
    } finally {
      removal.release();
      await pruning;
      (await waiting)?.[Symbol.dispose]?.();
    }
    expect(settled).toBe(true);
    await expectAbsent("legacy-runtime");
  });

  it("returns a prepared context before unrelated background pruning settles", async () => {
    config.agents!.defaults!.sandbox!.prune = { idleHours: 1, maxAgeDays: 0 };
    await updateRegistry({
      containerName: "expired-unrelated",
      backendId: "reserved-test",
      sessionKey: "agent:test:unrelated",
      image: "provider-image",
      createdAtMs: 1,
      lastUsedAtMs: 1,
    });
    const removal = createEnteredGate();
    const remove = install(
      undefined,
      vi.fn(async () => removal.wait()),
    );
    const preparing = resolve();
    try {
      const sandbox = await awaitGateBeforeSettlement(
        preparing,
        removal.entered,
        "Run start waited for unrelated pruning",
      );
      expect(sandbox?.runtimeId).toBe("reserved-1");
      await removal.entered;
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      removal.release();
      (await preparing)?.[Symbol.dispose]?.();
      await maybePruneSandboxes(config);
    }
    await expectAbsent("expired-unrelated");
  });

  it("rejects hosted custody released during reserved backend discovery before allocation", async () => {
    using owner = acquireSandboxGatewayOwner(workspaceDir);
    const discovery = createEnteredGate();
    const allocate = vi.fn();
    install(async (params) => {
      await discovery.wait();
      params.assertRuntimeCurrent?.();
      allocate();
      return handle(params);
    });
    const preparation = resolve();
    try {
      await awaitGateBeforeSettlement(
        discovery.entered,
        preparation,
        "Backend discovery not reached",
      );
      owner.release();
      discovery.release();
      const error = await preparation.catch((failure: unknown) => failure);
      expect(allocate).not.toHaveBeenCalled();
      expect(error).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      expect((await readRegistry()).entries).toEqual([
        expect.objectContaining({ runtimeState: "pending" }),
      ]);
    } finally {
      discovery.release();
      await preparation.catch(() => {});
    }
  });

  it("replays a shared reservation from its original provider workspace", async () => {
    config.agents!.defaults!.sandbox!.scope = "shared";
    const originalWorkspace = workspaceDir;
    install(async (params) => {
      if (params.workspaceDir !== originalWorkspace) {
        throw new Error("Provider repository owner changed");
      }
      return handle(params);
    });
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
  });

  it("rejects a prepared exec removed during supervisor admission and finalizes its artifacts", async () => {
    const marker = path.join(state.make("sandbox-admission-"), "spawned");
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
    await expectRuntime("reserved-1", {
      runtimeState: "removing-pending",
      workspaceDir,
    });
    configured = true;
    await removeSandboxContainer("reserved-1");
    expect(cleaned).toEqual(["reserved-1"]);
    expect(allocated.size).toBe(0);
    await expectAbsent("reserved-1");
    await expectResolvedId("reserved-2");
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
    const preparation = resolve();
    const creating =
      operation === "prune"
        ? preparation
        : expect(preparation).rejects.toThrow("removed or is being removed");
    const id = await started.promise;
    if (legacy) {
      expect(id).toBe("legacy-runtime");
    }
    const removing = legacyRemoval ?? startRemoval(id);
    if (operation === "prune") {
      try {
        await removing;
        expect(remove).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        (await preparation)?.[Symbol.dispose]?.();
      }
      await pruneImmediately();
      expect(remove).toHaveBeenCalledOnce();
      await expectAbsent(id);
      return;
    }
    try {
      await awaitGateBeforeSettlement(intent, removing, "Removal intent was not acknowledged");
      await expectRuntime(id, { runtimeState: "removing-pending" });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await Promise.allSettled([creating, removing]);
    }
    await creating;
    await removing;
    expect(remove).toHaveBeenCalledOnce();
    await expectAbsent(id);
    if (!legacy) {
      await expectResolvedId("reserved-2");
    }
  });

  it("prevents adoption of a legacy runtime while provider removal is pending", async () => {
    await seedLegacyRuntime();
    const removal = createEnteredGate();
    const factory = vi.fn(async (params: CreateSandboxBackendParams) => handle(params));
    install(factory, vi.fn<SandboxBackendManager["removeRuntime"]>(removal.wait));
    const removing = removeSandboxContainer("legacy-runtime");
    await removal.entered;
    try {
      await expect(resolve()).rejects.toThrow("removed or is being removed");
      expect(factory).not.toHaveBeenCalled();
    } finally {
      removal.release();
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
      await expectRuntime(backend.runtimeId, { runtimeState: "pending" });
      allocated.push(backend.runtimeId);
      if (fail) {
        throw error;
      }
      return backend;
    });
    await expect(resolve()).rejects.toThrow(error.message);
    await closeStateDatabaseForTest();
    fail = false;
    await expectResolvedId("reserved-1");
    expect(allocated).toEqual(["reserved-1", "reserved-1"]);
    await expectRuntime("reserved-1", {
      runtimeState: "ready",
      image: "provider-image",
      configLabelKind: "Provider",
    });
  });

  it("serializes concurrent creators onto one durable generation", async () => {
    const allocation = createEnteredGate();
    const secondReservation = createDeferred();
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
        await allocation.wait();
        active--;
        return backend;
      },
    });
    const first = resolve();
    let second: ReturnType<typeof resolve> | undefined;
    try {
      await awaitGateBeforeSettlement(allocation.entered, first, "First creator did not start");
      second = resolve();
      await awaitGateBeforeSettlement(
        secondReservation.promise,
        second,
        "Second creator did not reserve a runtime",
      );
      expect(nextId).toBe(2);
      allocation.release();
      const contexts = await Promise.all([first, second]);
      expect(contexts.map((context) => context?.runtimeId)).toEqual(["reserved-1", "reserved-1"]);
      expect(runtimeIds).toEqual(["reserved-1", "reserved-1"]);
      expect(maximumActive).toBe(1);
      expect((await readRegistry()).entries).toHaveLength(1);
    } finally {
      allocation.release();
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
    await expectRuntime("reserved-1", { runtimeState: "removing" });
    await removeSandboxContainer("reserved-1");
    await expectResolvedId("reserved-3");
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
