import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { SubagentRestartSettlementManager } from "./subagent-registry-run-recovery-settlement.js";
import type {
  SubagentRestartRecoveryReceipt,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-registry");

/** Owns restart-recovery launch receipt transitions. */
export class SubagentRestartRecoveryLaunchManager extends SubagentRestartSettlementManager {
  protected readonly unpersistedAcceptances = new WeakMap<
    SubagentRunRecord,
    SubagentRestartRecoveryReceipt
  >();

  readonly reserveSubagentRestartRecoveryLaunch = (reserveParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId: string;
    sessionMarker: string;
    sessionLifecycleRevision?: string;
    idempotencyKey: string;
  }): string | undefined => {
    const runId = reserveParams.runId.trim();
    const sessionId = reserveParams.sessionId.trim();
    const sessionMarker = reserveParams.sessionMarker.trim();
    const idempotencyKey = reserveParams.idempotencyKey.trim();
    const entry = this.options.runs.get(runId);
    if (
      !runId ||
      !sessionId ||
      !sessionMarker ||
      !idempotencyKey ||
      entry !== reserveParams.expected ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    const existing = entry.execution.restartRecovery;
    if (existing?.sessionMarker === sessionMarker && existing.idempotencyKey.trim().length > 0) {
      return existing.idempotencyKey;
    }
    const previousCollectorLaunch = {
      idempotencyKey: entry.swarmLaunchIdempotencyKey,
      pending: entry.swarmLaunchPending,
    };
    entry.execution.restartRecovery = {
      sessionId,
      sessionMarker,
      sessionLifecycleRevision: reserveParams.sessionLifecycleRevision,
      idempotencyKey,
      phase: "reserved",
    };
    if (entry.collect === true) {
      entry.swarmLaunchIdempotencyKey = idempotencyKey;
      entry.swarmLaunchPending = true;
    }
    try {
      // The exact source row owns this dispatch identity before Gateway can
      // accept it. A lost response can then replay the same logical run.
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = existing;
      entry.swarmLaunchIdempotencyKey = previousCollectorLaunch.idempotencyKey;
      entry.swarmLaunchPending = previousCollectorLaunch.pending;
      throw error;
    }
    return idempotencyKey;
  };

  readonly markSubagentRestartRecoveryLaunchAttempted = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
    lifecycleGeneration: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== markParams.expected ||
      receipt?.sessionMarker !== markParams.sessionMarker ||
      receipt.idempotencyKey !== markParams.idempotencyKey ||
      !isAgentEventLifecycleGenerationCurrent(markParams.lifecycleGeneration) ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    if (receipt.phase !== "reserved") {
      return receipt;
    }
    const attempted = {
      ...receipt,
      phase: "attempted" as const,
      lifecycleGeneration: markParams.lifecycleGeneration,
    };
    entry.execution.restartRecovery = attempted;
    try {
      // This is the at-most-once boundary. After it commits, recovery adopts
      // this run identity instead of replaying provider-visible side effects.
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return attempted;
  };

  readonly abandonSubagentRestartRecoveryLaunch = (abandonParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = abandonParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== abandonParams.expected ||
      receipt?.sessionMarker !== abandonParams.sessionMarker ||
      receipt.idempotencyKey !== abandonParams.idempotencyKey ||
      (receipt.phase !== "attempted" && receipt.phase !== "consumed")
    ) {
      return receipt?.phase === "abandoned";
    }
    const abandoned = { ...receipt, phase: "abandoned" as const };
    entry.execution.restartRecovery = abandoned;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return true;
  };

  readonly markSubagentRestartRecoveryLaunchConsumed = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== markParams.expected ||
      receipt?.sessionMarker !== markParams.sessionMarker ||
      receipt.idempotencyKey !== markParams.idempotencyKey ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    if (receipt.phase !== "attempted") {
      return receipt;
    }
    const consumed = { ...receipt, phase: "consumed" as const };
    entry.execution.restartRecovery = consumed;
    // A failed write must retain the irreversible in-memory handoff for the Gateway response.
    this.options.persistOrThrow(runId);
    return consumed;
  };

  readonly markSubagentRestartRecoveryLaunchAccepted = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== markParams.expected ||
      receipt?.sessionMarker !== markParams.sessionMarker ||
      receipt.idempotencyKey !== markParams.idempotencyKey ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    if (receipt.phase !== "consumed") {
      return receipt;
    }
    const accepted = Object.freeze({ ...receipt, phase: "accepted" as const });
    entry.execution.restartRecovery = accepted;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      // Gateway acceptance is irreversible. Keep the in-memory fact and let the
      // caller immediately attempt the strict successor remap.
      this.unpersistedAcceptances.set(entry, accepted);
      log.warn("failed to persist accepted subagent restart recovery receipt", {
        error,
        runId,
      });
    }
    return accepted;
  };

  readonly resetSubagentRestartRecoveryLaunchAttempt = (resetParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = resetParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== resetParams.expected ||
      receipt?.sessionMarker !== resetParams.sessionMarker ||
      receipt.idempotencyKey !== resetParams.idempotencyKey ||
      receipt.phase !== "attempted"
    ) {
      return receipt?.phase === "reserved";
    }
    const reserved = {
      sessionId: receipt.sessionId,
      sessionMarker: receipt.sessionMarker,
      sessionLifecycleRevision: receipt.sessionLifecycleRevision,
      idempotencyKey: receipt.idempotencyKey,
      phase: "reserved" as const,
    };
    entry.execution.restartRecovery = reserved;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return true;
  };
}
