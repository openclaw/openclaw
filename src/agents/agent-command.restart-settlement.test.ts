import path from "node:path";
import { expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
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
