import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  openIncognitoTestActor,
  useIncognitoActorProbe,
  useIncognitoNoHostSql,
} from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
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
const authority = { assertCurrent() {} };
const probe = useIncognitoActorProbe();
let env: NodeJS.ProcessEnv;
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let sibling: Awaited<ReturnType<typeof openIncognitoTestActor>>;
useIncognitoNoHostSql();

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("runtime-recovery-incognito-") };
  actor = await openIncognitoTestActor(env, authority);
  sibling = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: tempDirs.make("runtime-recovery-other-root-") },
    authority,
  );
});
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  clearRuntimeConfigSnapshot();
});
afterAll(async () => {
  await sibling.close();
  await actor.close();
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
  await owner.sessions.create(authority, { sessionKey, entry });
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
  await withIncognitoSessionActor(actor, async () => {
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
    ).rejects.toThrow("Explicit incognito database target does not match its agent and state root");
  });
});

it("keeps selected absence missing without discovering a durable or successor owner", async () => {
  const absentEnv = { OPENCLAW_STATE_DIR: tempDirs.make("runtime-recovery-absent-") };
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: absentEnv });
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "main", env: absentEnv, authority },
    async () => {
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
    },
  );
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(absentEnv)).toEqual([]);
});

it.each(["settle", "replacement"] as const)(
  "captures cancellation without waiting behind the actor and honors %s at commit",
  async (outcome) => {
    const target = await create(`cancel-snapshot-${outcome}`, {
      lifecycleRunId: "cancel-run",
      startedAt: 9_000,
    });
    setRuntimeConfigSnapshot({
      session: { store: path.join(env.OPENCLAW_STATE_DIR!, "sessions.json") },
    });
    const admission = new AbortController();
    const aborted = vi.fn(() => admission.abort());
    setActiveEmbeddedRun(
      target.sessionId,
      createEmbeddedRunHandle({ runId: "cancel-run", abort: aborted }),
      target.sessionKey,
      undefined,
      "main",
    );
    const held = probe.hold(actor, authority);
    await held.entered.promise;
    let replacementRegistered = false;
    const replacementAbort = vi.fn();
    const admissionProbe = sqliteWorkerOwnerProbe.admission(
      operationAdmission,
      (request, grant, admit) => {
        const facts = isRecord(request.facts) ? request.facts : undefined;
        const identity = isRecord(facts?.identity) ? facts.identity : undefined;
        const entry = isRecord(facts?.entry) ? facts.entry : undefined;
        if (
          outcome === "replacement" &&
          !replacementRegistered &&
          request.stage === "commit" &&
          identity?.incarnation === actor.identity.incarnation &&
          entry?.kind === "session-entry-patch-committed"
        ) {
          replacementRegistered = true;
          setActiveEmbeddedRun(
            target.sessionId,
            createEmbeddedRunHandle({ runId: "replacement-run", abort: replacementAbort }),
            target.sessionKey,
            undefined,
            "main",
          );
        }
        admit(request, grant);
      },
    );
    const clearing = withIncognitoSessionBinding({ actor, admissionSignal: admission.signal }, () =>
      abortAndDrainEmbeddedAgentRun({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        forceClear: true,
        settleMs: 0,
      }),
    );
    try {
      try {
        expect(aborted).toHaveBeenCalledOnce();
      } finally {
        held.release.resolve();
        await held.held;
      }
      await expect(clearing).resolves.toMatchObject({ forceCleared: true });
      const entry = (await actor.sessions.read(authority, target)).entry;
      expect(replacementRegistered).toBe(outcome === "replacement");
      if (outcome === "replacement") {
        expect(entry).toMatchObject({ sessionId: target.sessionId, lifecycleRunId: "cancel-run" });
        expect(entry?.status).toBeUndefined();
        expect(entry?.abortedLastRun).toBeUndefined();
        expect(isEmbeddedAgentRunHandleActive(target.sessionId)).toBe(true);
        expect(replacementAbort).not.toHaveBeenCalled();
      } else {
        expect(entry).toMatchObject({
          sessionId: target.sessionId,
          status: "killed",
          abortedLastRun: true,
        });
      }
    } finally {
      admissionProbe.mockRestore();
    }
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
  const recovering = withIncognitoSessionActor(actor, () =>
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
  expect((await actor.sessions.read(authority, target)).entry).toMatchObject({
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
  await withIncognitoSessionActor(actor, async () => {
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
    await patchSessionEntryCore(target, () => ({
      sendPolicy: "allow",
      lifecycleRevision: "successor",
    }));
    expect(() => isCurrent()).toThrow("generation is no longer current");
  });
});

it("refuses a replacement session after recovery preparation yields", async () => {
  const target = await create("replaced-recovery", {
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "old-run",
  });
  const runtime = recoveryRuntime(async () => {
    await patchSessionEntryCore(target, () => ({ lifecycleRevision: "replacement" }));
    return undefined;
  });
  await expect(
    withIncognitoSessionActor(actor, () =>
      retryRestartAbortedMainSessionRecovery({
        ...target,
        expectedSessionId: target.sessionId,
        gatewayRuntime: runtime,
      }),
    ),
  ).rejects.toThrow("generation is no longer current");
  expect(runtime.dispatchAgent).not.toHaveBeenCalled();
  expect((await actor.sessions.read(authority, target)).entry).toMatchObject({
    abortedLastRun: true,
    lifecycleRevision: "replacement",
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
  const result = await withIncognitoSessionActor(actor, () =>
    retryRestartAbortedMainSessionRecovery({
      ...target,
      expectedSessionId: target.sessionId,
      gatewayRuntime: runtime,
    }),
  );
  expect(result).toMatchObject({ failed: 1, started: 0, settled: 0 });
  expect(runtime.dispatchAgent).not.toHaveBeenCalled();
  expect(
    (await actor.sessions.read(authority, target)).entry?.restartRecoveryHarnessCompletion,
  ).toEqual(claim);
});
