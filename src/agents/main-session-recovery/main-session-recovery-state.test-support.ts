import assert from "node:assert/strict";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";
import type { MainSessionRecoveryCommand } from "./main-session-recovery-types.js";

export const recoveryRun = {
  cycleId: "cycle-1",
  lifecycleGeneration: "generation-1",
  runId: "recovery-1",
  sessionId: "session-1",
};

export function interruptedRecoveryEntry(
  overrides: Partial<SessionEntry> = {},
  recovery: Partial<MainRestartRecoveryState> = {},
): SessionEntry {
  return recoveryEntry({
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: recoveryState(recovery),
    ...overrides,
  });
}

export function prepareRecoveryAttempt(
  entry: SessionEntry,
  overrides: Partial<Extract<MainSessionRecoveryCommand, { kind: "prepare_attempt" }>> = {},
) {
  return transitionMainSessionRecovery(entry, {
    ...recoveryRun,
    kind: "prepare_attempt",
    attempt: 1,
    now: 200,
    observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
    executionIdentity: { state: "disabled" },
    ...overrides,
  });
}

export function admitRecoveryAttempt(
  entry: SessionEntry,
  now = 300,
  lifecycleGeneration = "generation-1",
) {
  return transitionMainSessionRecovery(entry, {
    ...recoveryRun,
    kind: "admit_recovery",
    now,
    lifecycleGeneration,
  });
}

export function interruptRecoveryAttempt(
  entry: SessionEntry,
  overrides: Partial<
    Extract<MainSessionRecoveryCommand, { kind: "mark_admitted_recovery_interrupted" }>
  > = {},
) {
  return transitionMainSessionRecovery(entry, {
    ...recoveryRun,
    kind: "mark_admitted_recovery_interrupted",
    attempt: 1,
    now: 400,
    ...overrides,
  });
}

export function observeRecovery(entry: SessionEntry, lifecycleGeneration = "generation-1") {
  const result = transitionMainSessionRecovery(entry, {
    kind: "observe",
    cycleId: "unused-cycle",
    lifecycleGeneration,
    sessionKey: "agent:main:main",
  });
  assert(result.kind === "observed", "expected recovery observation");
  return result.view;
}

export function recoveryState(
  overrides: Partial<MainRestartRecoveryState> = {},
): MainRestartRecoveryState {
  return { cycleId: "cycle-1", revision: 1, chargedAttempts: 0, ...overrides };
}

export function recoveryEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    abortedLastRun: false,
    mainRestartRecovery: recoveryState(),
    ...overrides,
  };
}

export function claimForeground(entry: SessionEntry, runId?: string) {
  return transitionMainSessionRecovery(entry, {
    kind: "claim_foreground",
    cycleId: "unused",
    lifecycleGeneration: "generation-1",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    claimId: "foreground-1",
    runId,
  });
}

export const executionIdentity = (runId: string) => ({
  tokenVersion: 1 as const,
  contextId: `context-${runId}`,
  executionId: `execution-${runId}`,
  runId,
  createdAt: 1,
});
