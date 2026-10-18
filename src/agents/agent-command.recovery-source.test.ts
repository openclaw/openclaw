import { afterEach, beforeEach, expect, it } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
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
