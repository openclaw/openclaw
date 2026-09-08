import { SubagentWaitManager } from "./subagent-registry-run-wait.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Owns post-accept restart recovery cleanup and resumed settlement. */
export class SubagentRestartSettlementManager extends SubagentWaitManager {
  readonly clearAcceptedSubagentRestartRecovery = (clearParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId: string;
    idempotencyKey: string;
    pendingNoticeIdempotencyKey?: string;
  }): boolean => {
    const runId = clearParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== clearParams.expected ||
      receipt?.phase !== "accepted" ||
      receipt.sessionId !== clearParams.sessionId ||
      receipt.idempotencyKey !== clearParams.idempotencyKey
    ) {
      return false;
    }
    const previousNotice = entry.resumptionNotice;
    entry.execution.restartRecovery = undefined;
    if (clearParams.pendingNoticeIdempotencyKey) {
      entry.resumptionNotice = {
        idempotencyKey: clearParams.pendingNoticeIdempotencyKey,
      };
    }
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      entry.resumptionNotice = previousNotice;
      throw error;
    }
    return true;
  };

  readonly clearPendingSubagentRecoveryNotice = (noticeParams: {
    runId: string;
    expected: SubagentRunRecord;
    idempotencyKey: string;
  }): boolean => {
    const runId = noticeParams.runId.trim();
    const entry = this.options.runs.get(runId);
    if (
      !runId ||
      entry !== noticeParams.expected ||
      entry.resumptionNotice?.idempotencyKey !== noticeParams.idempotencyKey
    ) {
      return false;
    }
    const previous = entry.resumptionNotice;
    entry.resumptionNotice = undefined;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.resumptionNotice = previous;
      throw error;
    }
    return true;
  };

  readonly resumeSettledSubagentRestartRecovery = (resumeParams: {
    runId: string;
    expected: SubagentRunRecord;
  }): boolean => {
    const runId = resumeParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (!runId || entry !== resumeParams.expected || receipt !== undefined) {
      return false;
    }
    if (entry.killIntent || entry.killReconciliation) {
      return true;
    }
    this.options.resumedRuns.delete(runId);
    this.options.resumeSubagentRun(runId);
    return true;
  };
}
