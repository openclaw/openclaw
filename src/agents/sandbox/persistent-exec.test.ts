import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteCronJobRowInDatabase } from "../../cron/store/row-codec.js";
import { withSettledLocalWorkspaceProjectionPath } from "../../gateway/worker-environments/local-workspace-settlement.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { rejectOnNextAbort } from "../test-helpers/abort-signal.js";
import { requireGit } from "../worktrees/git.js";
import { insertRegistryWorktree } from "../worktrees/registry.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import * as containerEngine from "./container-engine.js";
import {
  listDockerPersistentExecContainers,
  readDockerPersistentExecExtinctionProof,
  stopDockerPersistentExec,
} from "./docker-persistent-exec.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { bindLocalSandboxWorkspace, prepareLocalSandboxWorkspace } from "./local-workspace.js";
import * as persistentExecStore from "./persistent-exec-store.js";
import { createSandboxPersistentExecStore } from "./persistent-exec-store.js";
import type { SandboxPersistentExecRecord } from "./persistent-exec-store.types.js";
import {
  createSandboxPersistentExecOwner,
  settleSandboxPersistentExecsForRetirement,
} from "./persistent-exec.js";
import {
  createStreamSource,
  custodyTransitions,
  expected,
  receipt as baseReceipt,
  registryEntry,
  reservation,
  retained,
  setProcessOwner,
} from "./persistent-exec.test-helpers.js";
import {
  bindSandboxPersistentExecCapability,
  type DockerPersistentExecCleanupTarget,
  type DockerPersistentExecExtinctionProof,
  type SandboxPersistentExecCapability,
  type SandboxPersistentExecPreparation,
  type SandboxPersistentExecStopped,
} from "./persistent-exec.types.js";
import { removeRegistryEntry, updateRegistry } from "./registry.js";
import { createSandboxTestContext } from "./test-fixtures.js";

// mock-isolation: Docker removal is external I/O; durable custody transitions remain real.
vi.mock("./docker-persistent-exec.js", () => ({
  listDockerPersistentExecContainers: vi.fn(),
  readDockerPersistentExecExtinctionProof: vi.fn(),
  stopDockerPersistentExec: vi.fn(),
}));
// mock-isolation: generic custody cases isolate workspace I/O; managed cases load the real owner.
vi.mock("../../gateway/worker-environments/local-workspace-settlement.js", () => ({
  withSettledLocalWorkspaceProjectionPath: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
    cleanup();
  }),
);

type StartInput = Parameters<ReturnType<typeof createSandboxPersistentExecOwner>["start"]>[0];

// This lane substitutes physical Docker removal; the store suite exercises real proof minting.
const extinctionTargets = new WeakMap<
  DockerPersistentExecExtinctionProof,
  DockerPersistentExecCleanupTarget
>();

function stopped(target: DockerPersistentExecCleanupTarget): SandboxPersistentExecStopped {
  const extinction: DockerPersistentExecExtinctionProof = { kind: "docker-container-extinction" };
  extinctionTargets.set(extinction, structuredClone(target));
  return { reason: "cancelled", exitCode: null, extinction };
}

function replaceProcessOwner(record: SandboxPersistentExecRecord, foreign = false) {
  if (record.owner.startedAt === null) {
    throw new Error("Fixture process identity is unavailable");
  }
  // A mismatched birth time models controller death without spawning or killing a process.
  setProcessOwner(record, {
    ...record.owner,
    startedAt: record.owner.startedAt + 1,
    ...(foreign ? { namespace: "foreign-process-namespace" } : {}),
  });
}

async function fixture() {
  const root = tempDirs.make("openclaw-persistent-exec-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const registry = {
    ...registryEntry,
    workspaceDir: path.join(root, "workspace"),
    backendTarget: {
      key: "docker:fixture-daemon",
      globalArgs: ["--host", "unix:///var/run/docker.sock"],
    },
  };
  await updateRegistry(registry);
  const store = createSandboxPersistentExecStore();
  const {
    job,
    source,
    persist: persistJob,
  } = createStreamSource(path.join(root, "cron", "jobs.sqlite"));
  const receipt = structuredClone(baseReceipt);
  const exited = createDeferredCore<SandboxPersistentExecStopped>();
  const preparation = {
    receipt,
    start: vi.fn<SandboxPersistentExecPreparation["start"]>(async (admit) => await admit()),
    checkCurrent: vi.fn<SandboxPersistentExecPreparation["checkCurrent"]>(async () => {}),
    stopped: exited.promise,
    stop: vi.fn<SandboxPersistentExecPreparation["stop"]>(async () => stopped(receipt)),
  };
  const prepare = vi.fn<SandboxPersistentExecCapability["prepare"]>(async ({ attemptId }) => {
    receipt.attemptId = attemptId;
    return preparation;
  });
  const finalize = vi.fn<NonNullable<SandboxBackendHandle["finalizeExec"]>>(async () => {});
  const backend: SandboxBackendHandle = {
    id: "docker",
    runtimeId: registry.containerName,
    runtimeLabel: "fixture",
    workdir: "/workspace",
    buildExecSpec: async () => {
      throw new Error("Unexpected host process execution");
    },
    runShellCommand: async () => {
      throw new Error("Unexpected shell execution");
    },
    finalizeExec: finalize,
  };
  bindSandboxPersistentExecCapability(backend, {
    target: receipt.target,
    containerId: receipt.parentContainerId,
    containerName: registry.containerName,
    containerStartedAt: "2026-01-01T00:00:00.000Z",
    workdir: "/workspace",
    configHash: "fixture-config",
    imageReference: registry.image,
    resolveImage: async () => `sha256:${"c".repeat(64)}`,
    prepare,
  });
  vi.mocked(stopDockerPersistentExec).mockImplementation(async (target) => stopped(target));
  vi.mocked(listDockerPersistentExecContainers).mockResolvedValue([]);
  vi.mocked(readDockerPersistentExecExtinctionProof).mockImplementation((proof) => {
    const target = extinctionTargets.get(proof);
    if (!target) {
      throw new Error("Unknown fixture extinction proof");
    }
    return target;
  });
  vi.mocked(withSettledLocalWorkspaceProjectionPath).mockImplementation(
    async (_params, operation) => await operation(),
  );
  const clock = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const owner = createSandboxPersistentExecOwner({ scheduler });
  const controller = new AbortController();
  const releaseAuthority = vi.fn();
  const expectCustody = async (record: Partial<SandboxPersistentExecRecord>) => {
    expect(await store.list()).toEqual([expect.objectContaining(record)]);
  };
  const expectReleased = async () => {
    expect(await store.list()).toEqual([]);
    expect(releaseAuthority).toHaveBeenCalledOnce();
  };
  const input: StartInput = {
    ownerKey: `cron:${source.storeKey}:${job.id}`,
    source,
    backend,
    argv: job.schedule.command,
    assertCurrent: () => {},
    signal: controller.signal,
    onOutput: () => {},
    releaseAuthority,
  };
  const start = (overrides: Partial<StartInput> = {}) => owner.start({ ...input, ...overrides });
  const cancel = async (kind: "caller" | "retirement", message: string) => {
    if (kind === "caller") {
      controller.abort(new Error(message));
    } else {
      await expect(
        settleSandboxPersistentExecsForRetirement({ containerName: registry.containerName }),
      ).resolves.toEqual({ unresolved: [], localOwnerKeys: [] });
    }
  };
  const seedCustody = async (phase: "reserved" | "running" | "stopped") => {
    let record = retained(
      await store.reserve(
        {
          ...reservation,
          ownerKey: input.ownerKey,
          attemptId: receipt.attemptId,
        },
        input.assertCurrent,
        source,
      ),
    );
    if (phase === "reserved") {
      return record;
    }
    const advance = custodyTransitions(store, input.assertCurrent, source);
    record = await advance(await advance(record, "prepared", receipt), "running");
    if (phase === "stopped") {
      record = retained(
        await store.confirmContainerExtinction(expected(record), stopped(receipt).extinction),
      );
    }
    return record;
  };
  return {
    root,
    store,
    job,
    persistJob,
    registry,
    receipt,
    preparation,
    prepare,
    finalize,
    clock,
    scheduler,
    owner,
    controller,
    releaseAuthority,
    input,
    exited,
    start,
    cancel,
    seedCustody,
    expectCustody,
    expectReleased,
  };
}

it("records custody before allocation and the exact private container before START", async () => {
  const f = await fixture();
  f.prepare.mockImplementationOnce(async ({ attemptId }) => {
    f.receipt.attemptId = attemptId;
    await f.expectCustody({ attemptId, phase: "reserved", receipt: null });
    expect(f.preparation.start).not.toHaveBeenCalled();
    return f.preparation;
  });
  f.preparation.start.mockImplementationOnce(async (admit) => {
    await f.expectCustody({ phase: "prepared", receipt: f.receipt });
    await admit();
    await f.expectCustody({ phase: "running", receipt: f.receipt });
  });
  const run = await f.start();
  await run.waitForExtinction?.();
  await f.expectReleased();
});

it.each(["stop", "exit", "retirement", "checkpoint retry", "resume retry"] as const)(
  "checkpoints a managed stream before releasing stopped custody: %s",
  async (ending) => {
    const f = await fixture();
    setRuntimeConfigSnapshot({});
    const canonical = path.join(f.root, "canonical");
    const repo = path.join(f.root, "repo");
    await fs.mkdir(repo);
    await requireGit(repo, ["init", "--quiet", "-b", "main"]);
    await requireGit(repo, ["config", "user.name", "Test"]);
    await requireGit(repo, ["config", "user.email", "test@example.invalid"]);
    await fs.writeFile(path.join(repo, "source.txt"), "original\n");
    await requireGit(repo, ["add", "."]);
    await requireGit(repo, ["commit", "--quiet", "-m", "base"]);
    await requireGit(repo, ["worktree", "add", "--quiet", "-b", "openclaw/guest", canonical]);
    const sessionKey = "agent:main:watcher";
    const worktree = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "guest",
      repoFingerprint: "fixture",
      repoRoot: repo,
      path: canonical,
      branch: "openclaw/guest",
      baseRef: "main",
      ownerKind: "session" as const,
      ownerId: sessionKey,
      createdAt: 1,
      lastActiveAt: 1,
    };
    await insertRegistryWorktree(process.env, worktree);
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId: "creator-session", updatedAt: 1, worktree },
    );
    using projection = await prepareLocalSandboxWorkspace({
      cfg: { worktreeAcceleration: false },
      agentId: "main",
      sessionKey,
      workspaceDir: canonical,
      sandbox: resolveSandboxConfigForAgent({}, "main"),
    });
    expect(projection).toBeDefined();
    if (!projection) {
      throw new Error("Expected managed workspace");
    }
    await removeRegistryEntry(f.registry.containerName);
    await updateRegistry({
      ...f.registry,
      workspaceDir: projection.workspaceDir,
      workspaceSource: "managed-worktree",
    });
    const sandbox = createSandboxTestContext({
      overrides: { backend: f.input.backend, workspaceDir: projection.workspaceDir },
    });
    sandbox.fsBridge = createSandboxFsBridge({ sandbox: { ...sandbox, backend: f.input.backend } });
    bindLocalSandboxWorkspace(sandbox, projection);
    const settlement = await vi.importActual<
      typeof import("../../gateway/worker-environments/local-workspace-settlement.js")
    >("../../gateway/worker-environments/local-workspace-settlement.js");
    vi.mocked(withSettledLocalWorkspaceProjectionPath).mockImplementation(
      settlement.withSettledLocalWorkspaceProjectionPath,
    );
    f.releaseAuthority.mockImplementation(() => projection[Symbol.dispose]());
    let paused = false;
    let failResume = ending === "resume retry";
    // Docker is the external boundary; projection, checkpoint, and custody writes stay real.
    vi.spyOn(containerEngine, "execContainer").mockImplementation(async (_engine, args) => {
      if (args[0] === "info") {
        return { code: 0, stdout: "fixture-daemon", stderr: "" };
      }
      if (args[0] === "inspect") {
        if (
          args.at(-1) === f.registry.containerName ||
          args.at(-1) === f.receipt.parentContainerId
        ) {
          return {
            code: 0,
            stdout: args.includes("{{.State.Paused}}")
              ? String(paused)
              : `${f.receipt.parentContainerId} true ${paused}`,
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "no such container" };
      }
      if (args[0] === "pause" || args[0] === "unpause") {
        if (args[0] === "unpause" && failResume) {
          return { code: 1, stdout: "", stderr: "fixture daemon unavailable" };
        }
        paused = args[0] === "pause";
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected Docker action: ${args[0]}`);
    });
    const run = await f.start();
    await fs.writeFile(path.join(projection.workspaceDir, "source.txt"), "stream edit\n");
    if (ending === "checkpoint retry" || ending === "resume retry") {
      if (ending === "checkpoint retry") {
        await fs.writeFile(path.join(canonical, "source.txt"), "human edit\n");
      }
      await expect(run.waitForExtinction?.()).rejects.toThrow(
        ending === "checkpoint retry" ? "conflict" : "runtime resume failed",
      );
      await f.expectCustody({ phase: "stopped" });
      expect(projection.assertCurrent).toThrow("authority changed");
      if (ending === "checkpoint retry") {
        expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe("human edit\n");
        await fs.writeFile(path.join(canonical, "source.txt"), "original\n");
      }
      failResume = false;
      await f.owner.recover();
      await run.waitForExtinction?.();
    } else if (ending === "exit") {
      const result = { ...stopped(f.receipt), reason: "source-exited", exitCode: 0 };
      f.preparation.stop.mockResolvedValue(result);
      f.exited.resolve(result);
      await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    } else if (ending === "retirement") {
      await expect(
        settleSandboxPersistentExecsForRetirement({ containerName: f.registry.containerName }),
      ).resolves.toEqual({ unresolved: [], localOwnerKeys: [] });
    } else {
      await run.waitForExtinction?.();
    }
    expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe("stream edit\n");
    await f.expectReleased();
    expect(paused).toBe(false);
    expect(f.preparation.start).toHaveBeenCalledOnce();
  },
);

it.each(["caller", "retirement"] as const)(
  "removes a prepared container without START when %s cancels during preparation",
  async (cancellation) => {
    const f = await fixture();
    const entered = createDeferredCore();
    const prepared = createDeferredCore<SandboxPersistentExecPreparation>();
    f.prepare.mockImplementationOnce(({ attemptId }) => {
      f.receipt.attemptId = attemptId;
      entered.resolve();
      return prepared.promise;
    });
    const starting = f.start();
    await entered.promise;
    const rejected = expect(starting).rejects.toThrow(/cancelled/);
    const cancelled = f.cancel(cancellation, "creator cancelled");
    expect(f.preparation.stop).not.toHaveBeenCalled();
    prepared.resolve(f.preparation);
    await rejected;
    await cancelled;
    expect(f.preparation.start).not.toHaveBeenCalled();
    expect(f.preparation.stop).toHaveBeenCalledTimes(1);
    await f.expectReleased();
  },
);

it.each(["caller", "retirement"] as const)(
  "joins %s cancellation during START observation before releasing durable custody",
  async (cancellation) => {
    const f = await fixture();
    const entered = createDeferredCore();
    f.prepare.mockImplementationOnce(async ({ attemptId, signal }) => {
      f.receipt.attemptId = attemptId;
      f.preparation.start.mockImplementationOnce(async (admit) => {
        await admit();
        entered.resolve();
        await rejectOnNextAbort(signal, "START observation aborted");
      });
      return f.preparation;
    });
    const starting = f.start();
    const rejected = expect(starting).rejects.toThrow(
      cancellation === "caller" ? "stream stop requested" : "has been cancelled",
    );
    await entered.promise;
    await f.expectCustody({ phase: "running", receipt: f.receipt });
    const cancelled = f.cancel(cancellation, "stream stop requested");
    await rejected;
    await cancelled;
    expect(f.preparation.stop).toHaveBeenCalledOnce();
    await f.expectReleased();
  },
);

it("observes reservations from a later recovery lifecycle", async () => {
  const f = await fixture();
  await f.owner.recover();
  replaceProcessOwner(await f.seedCustody("running"));
  await f.owner.recover();
  expect(stopDockerPersistentExec).toHaveBeenCalledExactlyOnceWith(f.receipt, expect.any(Function));
  expect(await f.store.list()).toEqual([]);
});

it("recovers removed-job custody even when orphan discovery fails", async () => {
  const f = await fixture();
  replaceProcessOwner(await f.seedCustody("running"));
  runOpenClawStateWriteTransaction(({ db }) => {
    deleteCronJobRowInDatabase(db, f.input.source.storeKey, f.job.id);
  });
  vi.mocked(listDockerPersistentExecContainers).mockRejectedValueOnce(
    new Error("discovery failed"),
  );
  await expect(f.owner.recover()).rejects.toThrow("cleanup is incomplete");
  expect(stopDockerPersistentExec).toHaveBeenCalledExactlyOnceWith(f.receipt, expect.any(Function));
  expect(await f.store.list()).toEqual([]);
  // A late allocation still needs cleanup after its job and custody have gone.
  vi.mocked(listDockerPersistentExecContainers).mockResolvedValueOnce([f.receipt]);
  await f.owner.recover();
  expect(stopDockerPersistentExec).toHaveBeenCalledTimes(2);
});

it("keeps live custody acquired while orphan discovery is pending", async () => {
  const f = await fixture();
  vi.mocked(listDockerPersistentExecContainers).mockImplementationOnce(async () => {
    await f.seedCustody("reserved");
    return [f.receipt];
  });
  await f.owner.recover();
  expect(stopDockerPersistentExec).not.toHaveBeenCalled();
  await f.expectCustody({ phase: "reserved" });
});

it.each([
  { status: "live", phase: "running" },
  { status: "foreign", phase: "running" },
  { status: "live", phase: "reserved" },
] as const)(
  "blocks replacement of $status $phase custody and recovers only its original child",
  async ({ status, phase }) => {
    const f = await fixture();
    const record = await f.seedCustody(phase);
    const orphan = {
      ...f.receipt,
      attemptId: "00000000-0000-4000-8000-000000000002",
      containerId: "d".repeat(64),
    };
    vi.mocked(listDockerPersistentExecContainers).mockResolvedValueOnce([f.receipt, orphan]);
    if (status === "foreign") {
      replaceProcessOwner(record, true);
    }
    const prior = await f.store.list();
    await f.owner.recover();
    await expect(f.start()).rejects.toThrow("replacement is blocked");
    expect(await f.store.list()).toEqual(prior);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(stopDockerPersistentExec).toHaveBeenCalledExactlyOnceWith(orphan, expect.any(Function));
    vi.mocked(stopDockerPersistentExec).mockClear();
    replaceProcessOwner(record);
    await f.owner.recover();
    await f.owner.recover();
    expect(stopDockerPersistentExec).toHaveBeenCalledExactlyOnceWith(
      phase === "reserved"
        ? {
            target: f.receipt.target,
            attemptId: f.receipt.attemptId,
            parentContainerId: f.receipt.parentContainerId,
          }
        : f.receipt,
      expect.any(Function),
    );
    expect(await f.store.list()).toEqual([]);
  },
);

it("retains stopped custody through checkpoint failure and registry replacement without restarting", async () => {
  const f = await fixture();
  replaceProcessOwner(await f.seedCustody("stopped"));
  const replacement = {
    ...f.registry,
    workspaceDir: path.join(f.registry.workspaceDir, "replacement"),
    createdAtMs: f.registry.createdAtMs + 1,
  };
  const replaceRegistry = async (entry: typeof f.registry) => {
    await removeRegistryEntry(entry.containerName);
    await updateRegistry(entry);
  };
  await replaceRegistry(replacement);
  await expect(f.owner.recover()).rejects.toThrow("cleanup is incomplete");
  await f.expectCustody({ phase: "stopped", receipt: f.receipt });
  expect(withSettledLocalWorkspaceProjectionPath).not.toHaveBeenCalled();
  await replaceRegistry(f.registry);
  vi.mocked(withSettledLocalWorkspaceProjectionPath).mockRejectedValueOnce(
    new Error("checkpoint unavailable"),
  );
  await expect(f.owner.recover()).rejects.toThrow("cleanup is incomplete");
  await f.expectCustody({ phase: "stopped", receipt: f.receipt });
  vi.mocked(withSettledLocalWorkspaceProjectionPath).mockImplementationOnce(
    async (_params, operation) => {
      await replaceRegistry(replacement);
      return await operation();
    },
  );
  await expect(f.owner.recover()).rejects.toThrow("cleanup is incomplete");
  await f.expectCustody({ phase: "stopped", receipt: f.receipt });
  await replaceRegistry(f.registry);
  vi.mocked(withSettledLocalWorkspaceProjectionPath).mockImplementationOnce(
    async (_params, operation) => {
      await operation();
      throw new Error("runtime resume failed after checkpoint");
    },
  );
  await expect(f.owner.recover()).rejects.toThrow("cleanup is incomplete");
  await f.expectCustody({ phase: "stopped", receipt: f.receipt });
  await f.owner.recover();
  await f.owner.recover();
  expect(await f.store.list()).toEqual([]);
  expect(stopDockerPersistentExec).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});

it("retains uncertain stop custody and refuses a replacement until the same owner confirms extinction", async () => {
  const f = await fixture();
  const run = await f.start();
  f.preparation.stop.mockRejectedValue(new Error("daemon unavailable"));
  await expect(run.waitForExtinction?.()).rejects.toThrow("daemon unavailable");
  await f.expectCustody({ phase: "uncertain", receipt: f.receipt });
  await expect(f.start({ releaseAuthority: vi.fn() })).rejects.toThrow("daemon unavailable");
  expect(f.prepare).toHaveBeenCalledTimes(1);
  f.preparation.stop.mockResolvedValue(stopped(f.receipt));
  await f.owner.recover();
  await run.waitForExtinction?.();
  await f.expectReleased();
  expect(stopDockerPersistentExec).not.toHaveBeenCalled();
  expect(withSettledLocalWorkspaceProjectionPath).toHaveBeenCalledOnce();
  expect(f.finalize).not.toHaveBeenCalled();
});

it.each(["source", "registry", "parent container"] as const)(
  "stops without duplicate START when its %s authority is retired",
  async (retirement) => {
    const f = await fixture();
    const run = await f.start();
    if (retirement === "source") {
      f.job.enabled = false;
      f.persistJob();
    } else if (retirement === "registry") {
      await updateRegistry({ ...f.registry, runtimeState: "removing" });
    } else {
      f.preparation.checkCurrent.mockRejectedValue(new Error("parent container generation ended"));
    }
    await f.clock.advanceBy(20_000);
    await expect(run.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
    expect(f.preparation.stop).toHaveBeenCalledTimes(1);
    expect(f.preparation.start).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.scheduler.nextWakeAtMs).toBeNull();
    expect(await f.store.list()).toEqual([]);
  },
);

it("joins an in-flight authority check and workspace finalization before releasing durable custody", async () => {
  const f = await fixture();
  const checking = createEnteredGate();
  const finalizing = createEnteredGate();
  const createStore = persistentExecStore.createSandboxPersistentExecStore;
  const storeFactory = vi
    .spyOn(persistentExecStore, "createSandboxPersistentExecStore")
    .mockImplementationOnce((options) => {
      const store = createStore(options);
      return {
        ...store,
        async checkExecutionCurrent(...args) {
          const result = await store.checkExecutionCurrent(...args);
          await checking.wait();
          return result;
        },
      };
    });
  vi.mocked(withSettledLocalWorkspaceProjectionPath).mockImplementationOnce(
    async (_params, operation) => {
      await operation();
      await finalizing.wait();
    },
  );
  const run = await f.start();
  const wake = f.clock.advanceBy(20_000);
  await checking.entered;
  const settlement = run.waitForExtinction?.();
  try {
    expect(f.preparation.stop).not.toHaveBeenCalled();
    await f.expectCustody({ phase: "running" });
    checking.release();
    await finalizing.entered;
    await f.expectCustody({ phase: "stopped" });
    expect(f.releaseAuthority).not.toHaveBeenCalled();
  } finally {
    checking.release();
    finalizing.release();
    try {
      await Promise.all([settlement, wake]);
    } finally {
      storeFactory.mockRestore();
    }
  }
  await run.waitForExtinction?.();
  await f.expectReleased();
  expect(f.preparation.stop).toHaveBeenCalledTimes(1);
  expect(withSettledLocalWorkspaceProjectionPath).toHaveBeenCalledOnce();
  expect(f.finalize).not.toHaveBeenCalled();
  expect(f.scheduler.nextWakeAtMs).toBeNull();
});
