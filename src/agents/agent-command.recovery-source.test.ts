import { afterEach, beforeEach, expect, it } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
import { prepareSteeringDelivery } from "../auto-reply/reply/steering-delivery-preparation.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { isMainRestartRecoveryCandidate } from "../config/sessions/restart-recovery-state.js";
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

afterEach(() => clearRuntimeConfigSnapshot());
registerAgentCommandCompactionTestHooks();
beforeEach(() => {
  if (!state.cfg) {
    throw new Error("missing command fixture config");
  }
  setRuntimeConfigSnapshot(state.cfg);
});
const { loadSessionEntry, replaceSessionEntry, patchSessionEntryCore } = compactionTestRuntime;
const requesterOrigin = (previous = false) => ({
  sessionKey: `agent:main:dashboard:${previous ? "previous-parent" : "parent"}`,
  messageProvider: "webchat",
  senderId: previous ? "synthetic-previous-owner" : "synthetic-owner",
});
const runCommand = (params: Parameters<typeof agentCommandFromGatewayIngress>[0]) =>
  agentCommandFromGatewayIngress({ allowModelOverride: false, ...params }, ...GATEWAY_INGRESS_ARGS);

it.each([false, true])(
  "keeps admitted final ownership across post-run cache publication (successor: %s)",
  async (successor) => {
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
    await runCommand({
      sessionKey,
      sessionId,
      runId: "run-a",
      message: "Finish the admitted result",
      ...context,
      deliver: true,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:synthetic-child",
        sourceChannel: "internal",
        sourceTool: "subagent_settle",
      },
    });
    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
  },
);

it.each([
  ["settled", "dashboard"],
  ["settled", "subagent"],
  ["unresolved", "dashboard"],
  ["terminal-pending", "dashboard"],
] as const)(
  "keeps direct command steering bound to its admitted claim with predecessor custody %s in %s",
  async (predecessor, kind) => {
    const sessionId = "reused-child-session";
    const sessionKey = `agent:main:${kind}:reused-child`;
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
        requesterOrigin: requesterOrigin(true),
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
          expect(isMainRestartRecoveryCandidate(current!, sessionKey)).toBe(false);
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
    await runCommand({
      sessionKey,
      sessionId,
      runId,
      message: "Continue the child's work",
      deliver: false,
      channel: "webchat",
      requesterOrigin: requesterOrigin(),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:dashboard:parent",
        sourceChannel: "webchat",
        sourceTool: "sessions_send",
      },
    });
    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    if (kind === "subagent") {
      const settled = loadSessionEntry(target);
      expect(settled?.restartRecoveryRequesterSource).toBeUndefined();
      expect(settled?.restartRecoveryTerminalRunIds).toContain(runId);
    }
  },
);
