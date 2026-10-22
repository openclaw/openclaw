import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { waitForSessionNativeAttemptEnd } from "../sessions/session-controller.native-runtime.js";
import { readSessionControllerOperationState } from "../sessions/session-controller.state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { claimAgentSessionWriter } from "./embedded-agent-runner/run/session-bootstrap.js";
import {
  abortAndDrainEmbeddedAgentRun,
  detachActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
} from "./embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
  testing,
} from "./embedded-agent-runner/runs.test-support.js";
import { prepareRestartRecoveryDeliveryCurrent } from "./main-session-recovery/main-session-restart-recovery-delivery.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-recovery/main-session-restart-recovery-runtime.js";
import { resolveAgentRunSessionTarget } from "./run-session-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
let stateDir: string;
let actor: ReturnType<typeof memorySessionActorOwners.get>;
let sibling: typeof actor;
const bindings = new Map<string, SessionActorStorageBinding>();
let sql: ReturnType<typeof observeHostDataSql>;
function withMemory<T>(target: { storePath: string; sessionKey: string }, operation: () => T): T {
  const binding = bindings.get(`${target.storePath}\n${target.sessionKey}`);
  if (!binding) {
    throw new Error("Missing test memory binding");
  }
  return runWithSessionActorStorage(binding, operation);
}
beforeEach(() => {
  sql = observeHostDataSql();
});
const memoryPath = (root: string) =>
  resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: { OPENCLAW_STATE_DIR: root } });
beforeAll(() => {
  stateDir = tempDirs.make("runtime-recovery-incognito-");
  const owner = (root: string) =>
    memorySessionActorOwners.get({ agentId: "main", path: memoryPath(root) });
  actor = owner(stateDir);
  sibling = owner(tempDirs.make("runtime-recovery-other-root-"));
});
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  clearRuntimeConfigSnapshot();
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});
afterAll(async () => {
  for (const binding of bindings.values()) {
    await binding.actor.release();
  }
  memorySessionActorOwners.closeDatabase(sibling);
  memorySessionActorOwners.closeDatabase(actor);
});

async function create(name: string, patch: Partial<SessionEntry> = {}, owner = actor) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry: SessionEntry = {
    sessionId: name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lifecycleRevision: "initial",
    incognito: true,
    ...patch,
  };
  const handle = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  bindings.set(`${owner.path}\n${sessionKey}`, {
    actor: handle,
    authority,
    agentId: owner.agentId,
    path: owner.path,
  });
  await writeEntry(handle, entry);
  return { agentId: "main", sessionKey, sessionId: entry.sessionId, storePath: owner.path };
}

async function writeEntry(handle: SessionActorStorageBinding["actor"], entry: SessionEntry) {
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
}

function recoveryRuntime(
  prepareRestartRecovery: GatewayRecoveryRuntime["prepareRestartRecovery"] = () => undefined,
): GatewayRecoveryRuntime {
  const unexpected = vi.fn(async () => {
    throw new Error("Recovery must settle without redispatch");
  });
  return {
    prepareRestartRecovery,
    dispatchAgent: unexpected,
    dispatchSessionMethod: unexpected,
    waitForAgent: unexpected,
    sendRecoveryNotice: unexpected,
    resumeChatInput: unexpected,
  };
}

type Target = Awaited<ReturnType<typeof create>>;
const configFor = (root = stateDir) => ({ session: { store: path.join(root, "sessions.json") } });
const readEntry = (target: Target) => actor.readSession(target.sessionKey, authority)?.entry;
function recover(target: Target, runtime = recoveryRuntime()) {
  return withMemory(target, () =>
    retryRestartAbortedMainSessionRecovery({
      ...target,
      expectedSessionId: target.sessionId,
      gatewayRuntime: runtime,
    }),
  );
}
async function registerRun(target: Target, runId: string, abort: () => void) {
  const handle = createEmbeddedRunHandle({ runId, abort });
  const operation = registerTestEmbeddedRun(
    target.sessionId,
    handle,
    target.sessionKey,
    undefined,
    "main",
    undefined,
    undefined,
    { storeScope: target.storePath },
  );
  const writer = await withMemory(target, () =>
    claimAgentSessionWriter({
      ...target,
      sessionTarget: target,
      runId,
      replyOperation: operation,
      prompt: "incognito cleanup",
      workspaceDir: stateDir,
      timeoutMs: 30_000,
    }),
  );
  const state = readSessionControllerOperationState(operation);
  if (!writer || !state) {
    throw new Error("Missing admitted incognito writer");
  }
  const releaseFence = state.registerTerminalProducerFence((isCurrent, options) =>
    writer.revoke(isCurrent, options),
  );
  onTestFinished(() => {
    releaseFence();
    detachActiveEmbeddedRun(target.sessionId, handle, target.sessionKey);
    operation.complete();
  });
  return { operation, handle };
}

it("resolves partial markers and store/SID targets within the selected physical actor", async () => {
  const config = configFor();
  const target = await create("partial-target");
  await create("different-key", { sessionId: target.sessionId }, sibling);
  await withMemory(target, async () => {
    const resolve = (partial: Partial<Parameters<typeof resolveAgentRunSessionTarget>[0]>) =>
      resolveAgentRunSessionTarget({
        config,
        sessionId: target.sessionId,
        missingSessionKey: "resolve-existing",
        ...partial,
      });
    for (const partial of [
      { sessionFile: formatSqliteSessionFileMarker(target) },
      { sessionTarget: { agentId: "main", storePath: actor.path, sessionId: target.sessionId } },
    ]) {
      await expect(resolve(partial)).resolves.toMatchObject(target);
    }
    await expect(
      resolve({
        sessionFile: formatSqliteSessionFileMarker({ ...target, storePath: sibling.path }),
      }),
    ).rejects.toThrow("Session storage owner belongs to another state root");
  });
});

it("keeps selected absence missing without discovering a durable or successor owner", async () => {
  const absentRoot = tempDirs.make("runtime-recovery-absent-");
  const storePath = memoryPath(absentRoot);
  await expect(
    resolveAgentRunSessionTarget({
      config: configFor(absentRoot),
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "missing",
        storePath,
      }),
      sessionId: "missing",
      missingSessionKey: "resolve-existing",
    }),
  ).rejects.toThrow("Cannot resolve a session key");
  await expect(
    retryRestartAbortedMainSessionRecovery({
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-missing",
      storePath,
      expectedSessionId: "missing",
      gatewayRuntime: recoveryRuntime(),
    }),
  ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
  expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
});

it.each(["settle", "replacement", "incarnation"] as const)(
  "fences the incognito writer and honors %s before terminal persistence",
  async (outcome) => {
    const target = await create(`cancel-snapshot-${outcome}`, {
      lifecycleRunId: "cancel-run",
      startedAt: 9_000,
    });
    setRuntimeConfigSnapshot(configFor());
    const aborted = vi.fn();
    const native = await registerRun(target, "cancel-run", aborted);
    const other = await create(
      `same-id-other-owner-${outcome}`,
      { sessionId: target.sessionId },
      sibling,
    );
    const otherBefore = { ...sibling.readSession(other.sessionKey, authority)?.entry };
    let rawSettled = false;
    const rawSettlement = waitForSessionNativeAttemptEnd(
      target.sessionId,
      null,
      native.handle,
    ).then(() => {
      rawSettled = true;
    });
    const replacementAbort = vi.fn();
    let replacementEntry: SessionEntry | undefined;
    const storage = bindings.get(`${target.storePath}\n${target.sessionKey}`)?.actor.storage;
    if (!storage) {
      throw new Error("Missing incognito storage factory");
    }
    const acquire = storage.acquire.bind(storage);
    const preparation = vi.spyOn(storage, "acquire").mockImplementationOnce(async (...args) => {
      expect(aborted).toHaveBeenCalledOnce();
      if (outcome === "replacement") {
        await registerRun(target, "replacement-run", replacementAbort);
        await withMemory(target, () =>
          patchSessionEntryCore(target, () => ({ lifecycleRunId: "replacement-run" })),
        );
        replacementEntry = { ...readEntry(target)! };
      } else if (outcome === "incarnation") {
        await withMemory(target, () =>
          patchSessionEntryCore(target, () => ({
            sessionId: "successor-incarnation",
            lifecycleRevision: "successor-revision",
            lifecycleRunId: "successor-run",
            activeWriterRunId: "successor-run",
          })),
        );
        replacementEntry = { ...readEntry(target)! };
      }
      return acquire(...args);
    });
    onTestFinished(() => preparation.mockRestore());
    await expect(
      withMemory(target, () =>
        abortAndDrainEmbeddedAgentRun({
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          forceClear: true,
          settleMs: 0,
        }),
      ),
    ).resolves.toMatchObject({ aborted: true, drained: false, forceCleared: outcome === "settle" });
    expect(aborted).toHaveBeenCalledOnce();
    const entry = readEntry(target);
    expect(isEmbeddedAgentRunHandleActive(target.sessionId)).toBe(outcome !== "settle");
    expect(rawSettled).toBe(false);
    expect(sibling.readSession(other.sessionKey, authority)?.entry).toEqual(otherBefore);
    if (outcome !== "settle") {
      expect(entry).toEqual(replacementEntry);
      expect([entry?.status, entry?.abortedLastRun]).toEqual([undefined, undefined]);
      expect(replacementAbort).not.toHaveBeenCalled();
    } else {
      expect(entry).toMatchObject({
        sessionId: target.sessionId,
        status: "killed",
        abortedLastRun: true,
      });
      expect(entry?.activeWriterRunId).toBeUndefined();
    }
    detachActiveEmbeddedRun(target.sessionId, native.handle, target.sessionKey);
    await rawSettlement;
  },
);

it("settles same-process recovery through its original actor after preparation yields", async () => {
  const target = await create("pending-recovery", {
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "recovery-run",
    restartRecoveryDeliverySourceRunId: "source-run",
    pendingFinalDelivery: {
      kind: "replayable",
      text: "done",
      createdAt: 10_000,
      intentId: "delivered-intent",
      deliveries: [{ id: "delivered", state: "delivered" }],
    },
  });
  const gate = createDeferredCore<number | undefined>();
  const entered = createDeferredCore();
  const prepare = vi.fn(() => {
    entered.resolve();
    return gate.promise;
  });
  const recovering = recover(target, recoveryRuntime(prepare));
  await entered.promise;
  expect(prepare).toHaveBeenCalledOnce();
  gate.resolve(undefined);
  await expect(recovering).resolves.toMatchObject({ settled: 1, failed: 0 });
  expect(readEntry(target)).toMatchObject({ status: "done", abortedLastRun: false });
});

it("rechecks delivery policy and exact actor lifetime in retained notice callbacks", async () => {
  const deliveryContext = { channel: "telegram", to: "123" };
  const target = await create("delivery-guard", {
    restartRecoveryDeliveryRunId: "notice-run",
    restartRecoveryDeliveryContext: deliveryContext,
  });
  await withMemory(target, async () => {
    const { isCurrent, release } = await prepareRestartRecoveryDeliveryCurrent({
      ...target,
      recoveryRunId: "notice-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      deliveryContext,
      cfg: {},
    });
    try {
      expect(isCurrent()).toBe(true);
      await patchSessionEntryCore(target, () => ({ sendPolicy: "deny" }));
      expect(isCurrent()).toBe(false);
      await patchSessionEntryCore(target, () => ({ sendPolicy: "allow" }));
      expect(isCurrent()).toBe(true);
      actor.closeSession(target.sessionKey);
      expect(() => isCurrent()).toThrow("closed");
    } finally {
      release();
    }
  });
});

it("refuses a replacement session after recovery preparation yields", async () => {
  const target = await create("replaced-recovery", {
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "old-run",
  });
  const runtime = recoveryRuntime(async () => {
    actor.closeSession(target.sessionKey);
    const replacement = await actor.acquire(
      { database: actor.identity, sessionKey: target.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    try {
      await writeEntry(replacement, {
        sessionId: target.sessionId,
        updatedAt: Date.now(),
        incognito: true,
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "replacement-run",
      });
    } finally {
      await replacement.release();
    }
    return undefined;
  });
  await expect(recover(target, runtime)).rejects.toThrow("closed");
  expect(runtime.dispatchAgent).not.toHaveBeenCalled();
  expect(readEntry(target)).toMatchObject({
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "replacement-run",
  });
});

it("retains an owed completion when the exact admitted source input is absent", async () => {
  const claim = {
    taskId: "task",
    taskStatus: "succeeded" as const,
    taskRunId: "task-run",
    sourceRunId: "announce:task",
    requesterSessionKey: "agent:main:dashboard:incognito-completion-without-input",
    requesterAgentId: "main",
    sessionId: "completion-without-input",
    lifecycleRevision: "initial",
  };
  const target = await create(claim.sessionId, {
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "recovery",
    restartRecoveryDeliverySourceRunId: claim.sourceRunId,
    restartRecoverySourceIngress: "internal",
    restartRecoveryHarnessCompletion: claim,
  });
  const runtime = recoveryRuntime();
  const result = await recover(target, runtime);
  expect(result).toMatchObject({ failed: 1, started: 0, settled: 0 });
  expect(runtime.dispatchAgent).not.toHaveBeenCalled();
  expect(readEntry(target)?.restartRecoveryHarnessCompletion).toEqual(claim);
});
