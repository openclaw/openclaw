import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

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
