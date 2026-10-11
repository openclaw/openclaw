import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  abortAndDrainEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "./embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "./embedded-agent-runner/runs.test-support.js";
import { captureRestartRecoveryDeliveryCurrent } from "./main-session-recovery/main-session-restart-recovery-delivery.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-recovery/main-session-restart-recovery-runtime.js";
import { resolveAgentRunSessionTarget } from "./run-session-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
let env: NodeJS.ProcessEnv;
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
beforeAll(() => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("runtime-recovery-incognito-") };
  actor = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  });
  sibling = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("runtime-recovery-other-root-") },
    }),
  });
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
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
  return { agentId: "main", sessionKey, sessionId: entry.sessionId, storePath: owner.path };
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
  };
}

it("resolves partial markers and store/SID targets within the selected physical actor", async () => {
  const target = await create("partial-target");
  await create("different-key", { sessionId: target.sessionId }, sibling);
  await withMemory(target, async () => {
    for (const partial of [
      { sessionFile: formatSqliteSessionFileMarker(target) },
      { sessionTarget: { agentId: "main", storePath: actor.path, sessionId: target.sessionId } },
    ]) {
      await expect(
        resolveAgentRunSessionTarget({
          ...partial,
          sessionId: target.sessionId,
          missingSessionKey: "resolve-existing",
        }),
      ).resolves.toMatchObject(target);
    }
    await expect(
      resolveAgentRunSessionTarget({
        sessionFile: formatSqliteSessionFileMarker({ ...target, storePath: sibling.path }),
        sessionId: target.sessionId,
        missingSessionKey: "resolve-existing",
      }),
    ).rejects.toThrow("Session storage owner belongs to another state root");
  });
});

it("keeps selected absence missing without discovering a durable or successor owner", async () => {
  const absentEnv = { OPENCLAW_STATE_DIR: tempDirs.make("runtime-recovery-absent-") };
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: absentEnv });
  {
    await expect(
      resolveAgentRunSessionTarget({
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
  }
  expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
});

it("force-clears an active run through its memory snapshot", async () => {
  const target = await create("cancel-snapshot", {
    lifecycleRunId: "cancel-run",
    startedAt: 9_000,
  });
  setRuntimeConfigSnapshot({
    session: { store: path.join(env.OPENCLAW_STATE_DIR!, "sessions.json") },
  });
  const aborted = vi.fn();
  setActiveEmbeddedRun(
    target.sessionId,
    createEmbeddedRunHandle({ runId: "cancel-run", abort: aborted }),
    target.sessionKey,
    undefined,
    "main",
  );
  await expect(
    withMemory(target, () =>
      abortAndDrainEmbeddedAgentRun({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        forceClear: true,
        settleMs: 0,
      }),
    ),
  ).resolves.toMatchObject({ forceCleared: true });
  expect(aborted).toHaveBeenCalledOnce();
  expect(actor.readSession(target.sessionKey, authority)?.entry).toMatchObject({
    status: "killed",
    abortedLastRun: true,
  });
  expect(isEmbeddedAgentRunHandleActive(target.sessionId)).toBe(false);
});

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
  const recovering = withMemory(target, () =>
    retryRestartAbortedMainSessionRecovery({
      ...target,
      expectedSessionId: target.sessionId,
      gatewayRuntime: recoveryRuntime(prepare),
    }),
  );
  await entered.promise;
  expect(prepare).toHaveBeenCalledOnce();
  gate.resolve(undefined);
  await expect(recovering).resolves.toMatchObject({ settled: 1, failed: 0 });
  expect(actor.readSession(target.sessionKey, authority)?.entry).toMatchObject({
    status: "done",
    abortedLastRun: false,
  });
});

it("rechecks delivery policy and exact actor lifetime in retained notice callbacks", async () => {
  const deliveryContext = { channel: "telegram", to: "123" };
  const target = await create("delivery-guard", {
    restartRecoveryDeliveryRunId: "notice-run",
    restartRecoveryDeliveryContext: deliveryContext,
  });
  await withMemory(target, async () => {
    const isCurrent = captureRestartRecoveryDeliveryCurrent({
      ...target,
      recoveryRunId: "notice-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      deliveryContext,
      cfg: {},
    });
    expect(isCurrent()).toBe(true);
    await patchSessionEntryCore(target, () => ({ sendPolicy: "deny" }));
    expect(isCurrent()).toBe(false);
    await patchSessionEntryCore(target, () => ({ sendPolicy: "allow" }));
    expect(isCurrent()).toBe(true);
    actor.closeSession(target.sessionKey);
    expect(() => isCurrent()).toThrow("closed");
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
      expect(
        await replacement.storage!.mutate(
          {
            type: "session.entry.create",
            input: {
              entry: {
                sessionId: target.sessionId,
                updatedAt: Date.now(),
                incognito: true,
                abortedLastRun: true,
                restartRecoveryDeliveryRunId: "replacement-run",
              },
            },
          },
          authority,
        ),
      ).toMatchObject({ kind: "committed" });
    } finally {
      await replacement.release();
    }
    return undefined;
  });
  await expect(
    withMemory(target, () =>
      retryRestartAbortedMainSessionRecovery({
        ...target,
        expectedSessionId: target.sessionId,
        gatewayRuntime: runtime,
      }),
    ),
  ).rejects.toThrow("closed");
  expect(runtime.dispatchAgent).not.toHaveBeenCalled();
  expect(actor.readSession(target.sessionKey, authority)?.entry).toMatchObject({
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "replacement-run",
  });
});

it("retains an owed completion when the exact admitted source input is absent", async () => {
  const name = "completion-without-input";
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const claim = {
    taskId: "task",
    taskStatus: "succeeded" as const,
    taskRunId: "task-run",
    sourceRunId: "announce:task",
    requesterSessionKey: sessionKey,
    requesterAgentId: "main",
    sessionId: name,
    lifecycleRevision: "initial",
  };
  const target = await create(name, {
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "recovery",
    restartRecoveryDeliverySourceRunId: claim.sourceRunId,
    restartRecoverySourceIngress: "internal",
    restartRecoveryHarnessCompletion: claim,
  });
  const runtime = recoveryRuntime();
  const result = await withMemory(target, () =>
    retryRestartAbortedMainSessionRecovery({
      ...target,
      expectedSessionId: target.sessionId,
      gatewayRuntime: runtime,
    }),
  );
  expect(result).toMatchObject({ failed: 1, started: 0, settled: 0 });
  expect(runtime.dispatchAgent).not.toHaveBeenCalled();
  expect(
    actor.readSession(target.sessionKey, authority)?.entry?.restartRecoveryHarnessCompletion,
  ).toEqual(claim);
});
