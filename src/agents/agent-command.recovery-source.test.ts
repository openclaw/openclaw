import { afterEach, beforeEach, expect, it } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
import { prepareSteeringDelivery } from "../auto-reply/reply/steering-delivery-preparation.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import { readRestartRecoveryRequesterSource } from "./requester-run-recovery-source.js";

// Exercise real command admission, post-run publication and the marker transaction.
// Shared fixtures isolate model, provider/config/plugin and final transport dependencies.
afterEach(() => clearRuntimeConfigSnapshot());
registerAgentCommandCompactionTestHooks();
beforeEach(() => {
  if (!state.cfg) {
    throw new Error("missing command fixture config");
  }
  setRuntimeConfigSnapshot(state.cfg);
});

it.each([false, true])(
  "keeps admitted final ownership across post-run cache publication (successor: %s)",
  async (successor) => {
    const { loadSessionEntry, replaceSessionEntry, patchSessionEntryCore } = compactionTestRuntime;
    const sessionId = "same-session";
    const sessionKey = "agent:main:dashboard:admitted-final";
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    const context = { channel: "discord", to: "discord:dm:123" };
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "run-a",
      restartRecoveryDeliverySourceRunId: "run-a",
      restartRecoveryDeliveryContext: context,
    });
    state.runAgentAttemptMock.mockImplementationOnce(async () => {
      expect(loadSessionEntry(target)?.restartRecoveryDeliverySourceRunId).toBe("run-a");
      if (successor) {
        await patchSessionEntryCore(target, () => ({
          restartRecoveryDeliveryRunId: "run-b",
          restartRecoveryDeliverySourceRunId: "source-b",
          restartRecoveryDeliveryContext: context,
        }));
      }
      return makeCompactionResult({ sessionId, text: "A final result", runner: "embedded" });
    });
    state.deliverAgentCommandResultMock.mockImplementation(async (params) => {
      // updateSessionStoreAfterAgentRun has actually published the current row here.
      const entry = await params.resolveFreshSessionEntryForDelivery();
      expect(entry?.sessionId).toBe(sessionId);
      if (successor) {
        expect(entry?.restartRecoveryDeliverySourceRunId).toBe("source-b");
        expect(entry?.pendingFinalDelivery).toBeUndefined();
        expect(resolvePendingFinalDeliveryCompletion(params.result.payloads)).toBeUndefined();
      } else {
        expect(entry?.pendingFinalDelivery?.sourceRunId).toBe("run-a");
        expect(resolvePendingFinalDeliveryCompletion(params.result.payloads)).toMatchObject({
          recoveryRunId: "run-a",
        });
      }
      return { deliverySucceeded: false };
    });
    await agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId: "run-a",
        message: "Finish the admitted result",
        allowModelOverride: false,
        ...context,
        deliver: true,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:synthetic-child",
          sourceChannel: "internal",
          sourceTool: "subagent_settle",
        },
      },
      ...GATEWAY_INGRESS_ARGS,
    );
    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
  },
);

it.each(["settled", "unresolved", "terminal-pending"] as const)(
  "keeps direct command steering bound to its admitted claim with predecessor custody %s",
  async (predecessor) => {
    const { loadSessionEntry, replaceSessionEntry } = compactionTestRuntime;
    const sessionId = "reused-child-session";
    const sessionKey = "agent:main:dashboard:reused-child";
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    const previousRunId = "previous-child-command";
    const runId = "next-child-command";
    await replaceSessionEntry(target, {
      sessionId,
      lifecycleRevision: "same-child-incarnation",
      updatedAt: 1,
      spawnDepth: 1,
      status: "done",
      lastRunId: previousRunId,
      restartRecoveryDeliveryRunId: previousRunId,
      restartRecoveryDeliverySourceRunId: previousRunId,
      restartRecoveryDeliveryRequestFingerprint: "previous-request-fingerprint",
      restartRecoverySourceIngress: "internal",
      restartRecoveryRequesterSource: {
        agentId: "main",
        sessionKey,
        sessionId,
        lifecycleRevision: "same-child-incarnation",
        sourceRunId: previousRunId,
        requesterOrigin: {
          sessionKey: "agent:main:dashboard:previous-parent",
          messageProvider: "webchat",
          senderId: "synthetic-previous-owner",
        },
      },
      ...(predecessor !== "unresolved" ? { restartRecoveryTerminalRunIds: [previousRunId] } : {}),
      ...(predecessor === "terminal-pending"
        ? { restartRecoveryDeliveryReceiptState: "terminal-pending" as const }
        : {}),
    });
    state.runAgentAttemptMock.mockImplementationOnce(async () => {
      const current = loadSessionEntry(target);
      const delivery = prepareSteeringDelivery({
        ...target,
        sessionId,
        sourceTurnId: runId,
        entry: current,
        assertCurrent() {},
      });
      try {
        if (predecessor === "settled") {
          expect(current).toMatchObject({
            restartRecoveryDeliveryRunId: runId,
            restartRecoveryDeliverySourceRunId: runId,
            restartRecoveryTerminalRunIds: [previousRunId],
          });
          expect(current?.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
          expect(
            readRestartRecoveryRequesterSource({
              ...target,
              entry: current!,
              sourceRunId: runId,
            }),
          ).toMatchObject({
            sessionKey: "agent:main:dashboard:parent",
            messageProvider: "webchat",
            senderId: "synthetic-owner",
          });
          await expect(delivery.prepareCurrent()).resolves.toBeUndefined();
          expect(() => delivery.assertCurrent()).not.toThrow();
        } else {
          // An unresolved source or terminal send keeps its claim even when
          // another command runs; a tombstone alone cannot settle that send.
          expect(current).toMatchObject({
            restartRecoveryDeliveryRunId: previousRunId,
            restartRecoveryDeliverySourceRunId: previousRunId,
            restartRecoveryDeliveryRequestFingerprint: "previous-request-fingerprint",
            restartRecoveryRequesterSource: {
              sourceRunId: previousRunId,
              requesterOrigin: { senderId: "synthetic-previous-owner" },
            },
          });
          await expect(delivery.prepareCurrent()).rejects.toThrow(
            predecessor === "terminal-pending" ? "terminal-pending" : "stale-claim",
          );
        }
      } finally {
        delivery.release();
      }
      return makeCompactionResult({ sessionId, text: "Child result", runner: "embedded" });
    });
    await agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId,
        message: "Continue the child's work",
        allowModelOverride: false,
        deliver: false,
        channel: "webchat",
        requesterOrigin: {
          sessionKey: "agent:main:dashboard:parent",
          messageProvider: "webchat",
          senderId: "synthetic-owner",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:dashboard:parent",
          sourceChannel: "webchat",
          sourceTool: "sessions_send",
        },
      },
      ...GATEWAY_INGRESS_ARGS,
    );
    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
  },
);
