import { expect } from "vitest";
import {
  readChannelSourceTurnId,
  readChannelSourceTurnSameThreadRequired,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../../auto-reply/reply/source-turn-id.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../../config/sessions/restart-recovery-receipt.js";
import type { AgentHarness } from "../../harness/types.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { createEmbeddedRunHandle } from "../runs.test-support.js";

/** Assertions stay on the real dispatcher -> registered harness -> host binding path. */
export function createSourceTurnDispatchAssertions() {
  const originalSourceTurnId = "synthetic-original-source";
  return {
    stamp(params: object) {
      setChannelSourceTurnId(params, originalSourceTurnId);
      setChannelSourceTurnSameThreadRequired(params, true);
    },
    expectPrepared(params: object) {
      expect(readChannelSourceTurnId(params)).toBe(originalSourceTurnId);
      expect(readChannelSourceTurnSameThreadRequired(params)).toBe(true);
    },
    expectBinding(params: Parameters<AgentHarness["runAttempt"]>[0]) {
      const handle = createEmbeddedRunHandle({
        runId: params.runId,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        queueMessage: async () => {},
      });
      const authority = getGatewayToolCallerIdentity()?.embeddedRunToolAuthorityBinding?.({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey!,
        sessionFile: params.sessionFile,
        agentId: params.agentId,
        handle,
      });
      expect(authority?.sourceTurnId).toBe(originalSourceTurnId);
      expect(authority?.sourceTurnId).not.toBe(params.runId);
      const recoveredEntry = {
        sessionId: params.sessionId,
        updatedAt: 1,
        restartRecoveryDeliveryRunId: params.runId,
        restartRecoveryDeliverySourceRunId: originalSourceTurnId,
      };
      expect(
        resolveRestartRecoverySteeringBlockReason(
          recoveredEntry,
          params.sessionId,
          authority!.sourceTurnId!,
        ),
      ).toBeUndefined();
      expect(
        resolveRestartRecoverySteeringBlockReason(
          recoveredEntry,
          params.sessionId,
          "synthetic-unrelated-source",
        ),
      ).toBe("stale-claim");
      expect(
        resolveRestartRecoverySteeringBlockReason(
          recoveredEntry,
          "replaced-session",
          authority!.sourceTurnId!,
        ),
      ).toBe("stale-claim");
    },
  };
}
