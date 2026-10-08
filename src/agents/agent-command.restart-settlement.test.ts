import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import * as sessionAdmission from "../sessions/session-lifecycle-admission.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import { finishAgentCommandCleanup } from "./command/cleanup.js";
import * as modelSelection from "./command/model-selection.js";
import { markSessionCompletedAfterRecoveryCheckpoint } from "./main-session-recovery/main-session-restart-recovery-checkpoint.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverStore } from "./main-session-recovery/main-session-restart-recovery-store.js";

const {
  loadSessionEntry,
  replaceSessionEntry,
  rotateAgentEventLifecycleGeneration,
  createAgentRunRestartAbortError,
} = compactionTestRuntime;

registerAgentCommandCompactionTestHooks();

let persistGatewaySessionLifecycleEvent: typeof import("../gateway/session-lifecycle-state.js").persistGatewaySessionLifecycleEvent;

beforeAll(async () => {
  ({ persistGatewaySessionLifecycleEvent } = await import("../gateway/session-lifecycle-state.js"));
});

it.each([
  "stopped",
  "replaced session",
  "replaced claim",
  "newer outcome",
  "restart handoff",
  "pending delivery",
  "new execution",
  "new generation",
] as const)("settles only the stopped command's unowned claim: %s", async (scenario) => {
  const sessionKey = "agent:main:main";
  const sessionId = "stopped-command-session";
  const runId = "stopped-command";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
  const receipt = { runId: "completed-source", captured: true as const };
  const entry: SessionEntry = {
    sessionId,
    updatedAt: 100,
    startedAt: 100,
    lifecycleRunId: runId,
    restartRecoveryDeliveryRunId: runId,
    restartRecoveryDeliverySourceRunId: runId,
    restartRecoverySourceIngress: "control-ui",
    restartRecoveryRuns: [{ runId, lifecycleGeneration }],
    restartRecoveryTerminalRunIds: [receipt.runId],
    restartRecoveryTerminalDeliveryEvidence: [receipt],
  };
  await replaceSessionEntry(target, entry);
  await persistGatewaySessionLifecycleEvent({
    sessionKey,
    event: {
      runId,
      sessionId,
      lifecycleGeneration,
      ts: 200,
      data: { phase: "end", aborted: true, stopReason: "rpc" },
    },
  });
  const stopped = loadSessionEntry(target);
  expect(stopped).toMatchObject({ status: "killed", abortedLastRun: true, lastRunId: runId });
  expect(stopped?.restartRecoveryRuns).toBeUndefined();
  const changes: Partial<SessionEntry> =
    scenario === "replaced session"
      ? { sessionId: "replacement-session" }
      : scenario === "replaced claim"
        ? { restartRecoveryDeliveryRunId: "replacement-run" }
        : scenario === "newer outcome"
          ? { lastRunId: "replacement-run" }
          : scenario === "restart handoff"
            ? { mainRestartRecovery: { cycleId: "restart-cycle", revision: 1, chargedAttempts: 0 } }
            : scenario === "pending delivery"
              ? {
                  pendingFinalDelivery: {
                    kind: "transport-only",
                    createdAt: 200,
                    intentId: "pending-final",
                    context: { channel: "discord", to: "discord:dm:123" },
                    deliveries: [{ id: "uncertain-delivery", state: "unknown" }],
                  },
                }
              : scenario === "new execution"
                ? { restartRecoveryRuns: [{ runId: "next-run", lifecycleGeneration }] }
                : {};
  await compactionTestRuntime.patchSessionEntryCore(target, () => changes);
  const beforeCleanup = loadSessionEntry(target);
  if (scenario === "new generation") {
    rotateAgentEventLifecycleGeneration();
  }
  await finishAgentCommandCleanup({
    prepared: {
      ...target,
      sessionAgentId: target.agentId,
      runId,
      sessionStore: { [sessionKey]: entry },
    },
    sessionEntry: entry,
    runOwnedSessionId: sessionId,
    sessionReboundDuringRun: false,
    trackedRestartRecoveryDeliveryClaim: true,
    terminalEvent: { data: { phase: "end", aborted: true, stopReason: "rpc" } },
    lifecycleGeneration,
    beforeTerminalDelivery: undefined,
    reportCommitted: () => {},
    preparedRunAdmission: undefined,
    sessionWorkAdmission: undefined,
    cleanupInternalModelRunTargets: async () => {},
    releaseForeground: undefined,
  });
  const settled = loadSessionEntry(target);
  if (scenario !== "stopped") {
    expect(settled).toEqual(beforeCleanup);
    return;
  }
  expect(settled).toMatchObject({
    status: "killed",
    abortedLastRun: true,
    lastRunId: runId,
    restartRecoveryTerminalRunIds: [receipt.runId, runId],
    restartRecoveryTerminalDeliveryEvidence: [receipt],
  });
  expect(settled?.restartRecoveryDeliveryRunId).toBeUndefined();
  expect(settled?.restartRecoveryDeliverySourceRunId).toBeUndefined();
});

it("preserves a stopped source claim when generation retires before post-run persistence", async () => {
  const sessionKey = "agent:main:main";
  const sessionId = "stopped-post-run-session";
  const runId = "stopped-post-run";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
  await replaceSessionEntry(target, { sessionId, updatedAt: 100 });
  state.runAgentAttemptMock.mockResolvedValue(
    makeCompactionResult({ sessionId, text: "Completed before Stop", runner: "embedded" }),
  );
  const controller = new AbortController();
  let deliverySettled = false;
  let generationRetired = false;
  state.deliverAgentCommandResultMock.mockImplementationOnce(async () => {
    expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBe(runId);
    await persistGatewaySessionLifecycleEvent({
      sessionKey,
      event: {
        runId,
        sessionId,
        lifecycleGeneration,
        ts: Date.now(),
        data: { phase: "end", aborted: true, stopReason: "rpc" },
      },
    });
    controller.abort();
    deliverySettled = true;
    return { deliverySucceeded: true };
  });
  const patch = sessionAccessor.patchSessionEntryCore;
  using _ = vi
    .spyOn(sessionAccessor, "patchSessionEntryCore")
    .mockImplementation((scope, update, options) => {
      if (deliverySettled && !generationRetired && options?.workerGuard?.source) {
        generationRetired = true;
        rotateAgentEventLifecycleGeneration();
      }
      return patch(scope, update, options);
    });
  await expect(
    agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId,
        message: "Finish this turn",
        allowModelOverride: false,
        abortSignal: controller.signal,
        operatorAuthority: createAdmittedRunOperatorAuthority({
          profileId: "synthetic-operator",
          scopes: ["operator.admin"],
          recoverySnapshot: {
            profileId: "synthetic-operator",
            scopes: ["operator.admin"],
            assignedRole: null,
            githubLogin: null,
            grant: null,
            aliasBindingIds: [],
            authPolicy: {
              generation: "",
              grantGeneration: "synthetic-generation",
              role: "operator",
              authMethod: "token",
            },
            controlUiAdmin: true,
            localOperator: true,
            sourceIngress: "control-ui",
          },
          assertCurrent() {},
        }),
      },
      ...GATEWAY_INGRESS_ARGS,
    ),
  ).rejects.toThrow("stale gateway lifecycle");
  expect(generationRetired).toBe(true);
  expect(loadSessionEntry(target)).toMatchObject({
    status: "killed",
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: runId,
    restartRecoveryDeliverySourceRunId: runId,
  });
  expect(loadSessionEntry(target)?.restartRecoveryTerminalRunIds ?? []).not.toContain(runId);
});

it.each([false, true])(
  "queues image follow-up and revalidates session replacement=%s",
  async (replace) => {
    const sessionKey = "agent:main:image-roundtrip";
    const sessionId = "image-roundtrip-session";
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    await replaceSessionEntry(target, { sessionId, updatedAt: Date.now() });
    const completionEntered = createDeferred();
    const finishCompletion = createDeferred();
    const followupQueued = createDeferred();
    const runs: string[] = [];
    state.runAgentAttemptMock.mockImplementation(async (params) => {
      runs.push(params.runId);
      if (params.runId === "image-completion") {
        completionEntered.resolve();
        await finishCompletion.promise;
      }
      return makeCompactionResult({ sessionId, text: "A lighthouse", runner: "embedded" });
    });
    const completion = agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId: "image-completion",
        message: "Describe the completed image",
        allowModelOverride: false,
        internalDeliveryMediaUrls: ["/synthetic/lighthouse.png"],
        forceRestartSafeTools: true,
        disableMessageTool: true,
        sourceReplyDeliveryMode: "automatic",
        inputProvenance: { kind: "inter_session", sourceTool: "image_generate" },
        beforeTerminalDelivery: async () => {
          if (replace) {
            await replaceSessionEntry(target, {
              sessionId: "replacement-session",
              updatedAt: Date.now(),
            });
          }
        },
      },
      ...GATEWAY_INGRESS_ARGS,
    );
    let followup: Promise<unknown> | undefined;
    try {
      await awaitGateBeforeSettlement(
        completionEntered.promise,
        completion,
        "completion did not run",
      );
      expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBe("image-completion");
      const beginAdmission = sessionAdmission.beginSessionWorkAdmission;
      using _ = vi
        .spyOn(sessionAdmission, "beginSessionWorkAdmission")
        .mockImplementation((params) => {
          const pending = beginAdmission(params);
          followupQueued.resolve();
          return pending;
        });
      followup = agentCommandFromGatewayIngress(
        {
          sessionKey,
          sessionId,
          runId: "inspect-image",
          message: "Describe this lighthouse attachment",
          allowModelOverride: false,
          operatorAuthority: createAdmittedRunOperatorAuthority({
            profileId: "synthetic-operator",
            scopes: ["operator.admin"],
            assertCurrent() {},
          }),
        },
        ...GATEWAY_INGRESS_ARGS,
      );
      void followup.catch(() => {});
      await awaitGateBeforeSettlement(followupQueued.promise, followup, "follow-up did not queue");
      const barrier = await beginAdmission({
        scope: target.storePath,
        identities: [sessionKey, sessionId],
        assertAllowed() {},
      });
      barrier.release();
      expect(runs).toEqual(["image-completion"]);
      finishCompletion.resolve();
      await completion;
      if (replace) {
        await expect(followup).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
        expect(runs).toEqual(["image-completion"]);
        expect(loadSessionEntry(target)?.sessionId).toBe("replacement-session");
      } else {
        await followup;
        expect(runs).toEqual(["image-completion", "inspect-image"]);
      }
      expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
    } finally {
      finishCompletion.resolve();
      await Promise.allSettled([completion, ...(followup ? [followup] : [])]);
    }
  },
);

it.each(["pre-model", "attempt"] as const)(
  "retires only the failed local execution fence after a %s error",
  async (boundary) => {
    const sessionKey = `agent:main:dashboard:local-failure-${boundary}`;
    const sessionId = `local-failure-${boundary}`;
    const runId = `failed-local-${boundary}`;
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const scope = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    const failure = new Error(`ordinary ${boundary} failure`);
    const siblingFence = { runId: "sibling-run", lifecycleGeneration };
    const siblingClaim = {
      restartRecoveryDeliveryRunId: "sibling-delivery",
      restartRecoveryDeliverySourceRunId: "sibling-source",
      restartRecoverySourceIngress: "control-ui" as const,
      restartRecoveryTerminalRunIds: ["previous-terminal"],
    };
    const failAdmittedRun = async () => {
      expect(loadSessionEntry(scope)?.restartRecoveryRuns).toEqual([
        { runId, lifecycleGeneration },
      ]);
      expect(loadSessionEntry(scope)?.restartRecoveryDeliveryRunId).toBeUndefined();
      await compactionTestRuntime.patchSessionEntryCore(scope, (entry) => ({
        ...siblingClaim,
        restartRecoveryRuns: [...(entry.restartRecoveryRuns ?? []), siblingFence],
      }));
      throw failure;
    };
    const selection =
      boundary === "pre-model"
        ? vi
            .spyOn(modelSelection, "resolveEmbeddedModelSelection")
            .mockImplementationOnce(failAdmittedRun)
        : undefined;
    if (boundary === "attempt") {
      state.runAgentAttemptMock.mockImplementationOnce(failAdmittedRun);
    }
    try {
      await expect(
        agentCommand({ sessionKey, sessionId, runId, message: "Attempt this local turn" }),
      ).rejects.toThrow(failure.message);
    } finally {
      selection?.mockRestore();
    }
    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(boundary === "attempt" ? 1 : 0);
    expect(loadSessionEntry(scope)).toMatchObject({
      ...siblingClaim,
      restartRecoveryRuns: [siblingFence],
      restartRecoveryTerminalRunIds: ["previous-terminal", runId],
    });
  },
);

it.each(["unknown", "delivered"] as const)(
  "admits the next agent turn after settling a %s final across another restart",
  async (deliveryState) => {
    const sessionId = "settled-session";
    const sessionKey = "agent:main:restart-settlement";
    const runId = "interrupted-recovery";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const sourceRunId = "interrupted-source";
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    const stateDir = path.dirname(target.storePath);
    const context = { channel: "discord", to: "discord:dm:123" };
    const previousEvidence = {
      runId: "previous-source",
      captured: true as const,
      payloads: [{ visible: true }],
    };
    const interrupted: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      startedAt: Date.now() - 100,
      status: "interrupted",
      abortedLastRun: true,
      lifecycleRunId: runId,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: sourceRunId,
      restartRecoverySourceIngress: "control-ui",
      restartRecoveryRuns: [{ runId, lifecycleGeneration }],
      restartRecoveryTerminalRunIds: ["previous-source"],
      restartRecoveryTerminalDeliveryEvidence: [previousEvidence],
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: Date.now(),
        intentId: "settled-final",
        context,
        deliveries: [{ id: "settled-delivery", state: deliveryState }],
      },
    };
    await replaceSessionEntry(target, interrupted);
    const unexpectedDispatch = vi.fn(async (): Promise<never> => {
      throw new Error("A terminal final must not dispatch recovery work");
    });
    const gatewayRuntime: GatewayRecoveryRuntime = {
      prepareRestartRecovery: () => undefined,
      dispatchAgent: unexpectedDispatch,
      dispatchSessionMethod: unexpectedDispatch,
      sendRecoveryNotice: unexpectedDispatch,
      waitForAgent: unexpectedDispatch,
    };
    const recover = () =>
      recoverStore({
        ...target,
        storeAgentId: target.agentId,
        cfg: state.cfg,
        stateDir,
        handledSessionKeys: new Set(),
        gatewayRuntime,
      });

    await expect(recover()).resolves.toEqual({ started: 0, settled: 1, skipped: 0, failed: 0 });
    const settled = loadSessionEntry(target);
    expect(settled).toMatchObject({
      status: "done",
      abortedLastRun: false,
      lastRunId: sourceRunId,
      restartRecoveryTerminalRunIds: ["previous-source", sourceRunId],
      restartRecoveryTerminalDeliveryEvidence: [previousEvidence],
    });
    expect(settled?.pendingFinalDelivery).toBeUndefined();
    expect(settled?.pendingDeliveryNotice).toEqual(
      deliveryState === "unknown"
        ? {
            createdAt: interrupted.pendingFinalDelivery!.createdAt,
            context,
            intentId: "settled-final",
            state: "owed",
          }
        : undefined,
    );

    await expect(recover()).resolves.toEqual({ started: 0, settled: 0, skipped: 0, failed: 0 });
    await expect(
      markSessionCompletedAfterRecoveryCheckpoint({
        ...target,
        entry: interrupted,
        messages: [],
        pendingFinalDeliveryIntentId: "settled-final",
        reason: "delivered-terminal-receipt",
      }),
    ).resolves.toEqual({ outcome: "changed" });
    rotateAgentEventLifecycleGeneration();
    await markStartupOrphanedMainSessionsForRecovery({ cfg: state.cfg, stateDir });
    await expect(recover()).resolves.toEqual({ started: 0, settled: 0, skipped: 0, failed: 0 });
    expect(loadSessionEntry(target)).toEqual(settled);
    expect(unexpectedDispatch).not.toHaveBeenCalled();

    state.runAgentAttemptMock.mockResolvedValue(
      makeCompactionResult({
        sessionId,
        text: "Next instruction completed",
        runner: "embedded",
      }),
    );
    await agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId: "next-instruction",
        message: "Process the next instruction",
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
    );
    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    const completed = loadSessionEntry(target);
    expect(completed?.mainRestartRecovery).toBeUndefined();
    expect(completed?.restartRecoveryRuns).toBeUndefined();
    expect(completed?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(completed?.restartRecoveryTerminalRunIds).toEqual(["previous-source", sourceRunId]);
    expect(completed?.restartRecoveryTerminalDeliveryEvidence).toContainEqual(previousEvidence);

    await finishAgentCommandCleanup({
      prepared: {
        ...target,
        runId,
        sessionAgentId: target.agentId,
        sessionStore: { [sessionKey]: interrupted },
      },
      sessionEntry: interrupted,
      runOwnedSessionId: sessionId,
      sessionReboundDuringRun: false,
      trackedRestartRecoveryDeliveryClaim: true,
      terminalEvent: { data: { phase: "end" } },
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      beforeTerminalDelivery: undefined,
      reportCommitted: () => {},
      preparedRunAdmission: undefined,
      sessionWorkAdmission: undefined,
      cleanupInternalModelRunTargets: async () => {},
      releaseForeground: undefined,
    });
    expect(loadSessionEntry(target)).toEqual(completed);
  },
);

it.each([
  { owner: "main", metadata: {} },
  { owner: "spawned child", metadata: { spawnDepth: 1 } },
  { owner: "role-owned child", metadata: { subagentRole: "leaf" } },
  {
    owner: "child with retained fence",
    metadata: {
      spawnDepth: 1,
      restartRecoveryRuns: [
        { runId: "previous-owner", lifecycleGeneration: "previous-generation" },
      ],
    },
  },
] satisfies Array<{ owner: string; metadata: Partial<SessionEntry> }>)(
  "arms command execution recovery only for its eligible owner: $owner",
  async ({ owner, metadata }) => {
    const sessionKey = "agent:main:dashboard:recovery-admission";
    const sessionId = "recovery-admission-session";
    const runId = "restart-aborted-admission";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    const entry: SessionEntry = { sessionId, updatedAt: Date.now(), ...metadata };
    await replaceSessionEntry(target, entry);
    state.runAgentAttemptMock.mockRejectedValue(createAgentRunRestartAbortError());

    await expect(
      agentCommandFromGatewayIngress(
        {
          sessionKey,
          sessionId,
          runId,
          message: "Continue visible work",
          allowModelOverride: false,
        },
        ...GATEWAY_INGRESS_ARGS,
      ),
    ).rejects.toMatchObject({ code: "OPENCLAW_RESTART_ABORT" });

    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    const admitted = loadSessionEntry(target);
    expect(admitted?.restartRecoveryRuns).toEqual(
      owner === "main" ? [{ runId, lifecycleGeneration }] : entry.restartRecoveryRuns,
    );
    expect(admitted?.restartRecoveryDeliveryRunId).toBeUndefined();
  },
);
