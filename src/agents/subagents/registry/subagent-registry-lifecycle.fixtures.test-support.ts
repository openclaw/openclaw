/**
 * Pure fixture builders shared by the subagent registry lifecycle suites.
 *
 * Extracted from subagent-registry-lifecycle.test.ts so that file stays under
 * its line cap. Nothing here touches a hoisted mock: every helper either
 * shapes a run record / completion request or drives a controller the caller
 * already built.
 */
import { vi } from "vitest";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import {
  createRunEntry,
  type RunEntryOverrides,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleController = SubagentLifecycleController;
export type SubagentCompletionParams = Parameters<LifecycleController["completeSubagentRun"]>[0];
export type RestartRecoveryReceipt = NonNullable<SubagentRunRecord["execution"]["restartRecovery"]>;
export type RunModeCleanupEntryOverrides = Omit<RunEntryOverrides, "execution"> & {
  execution?: Partial<SubagentRunRecord["execution"]>;
};

export function waitForLifecycleState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

export function makeProvisionalKilledRunEntry(
  overrides: RunEntryOverrides = {},
): SubagentRunRecord {
  return createRunEntry({
    endedAt: 4_000,
    endedReason: SUBAGENT_ENDED_REASON_KILLED,
    outcome: { status: "error", error: "agent run aborted" },
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt: 4_000 },
    cleanupHandled: true,
    cleanupCompletedAt: 4_000,
    ...overrides,
  });
}

export function makeRestartRecoveryReceipt(
  overrides: Partial<RestartRecoveryReceipt> = {},
): RestartRecoveryReceipt {
  return {
    sessionId: "session-id",
    sessionMarker: "session-id:1",
    idempotencyKey: "recovery-run",
    phase: "accepted",
    ...overrides,
  };
}

export function makeRunModeCleanupEntry(
  transcriptSessionId: string,
  overrides: RunModeCleanupEntryOverrides = {},
): SubagentRunRecord {
  const { execution, ...recordOverrides } = overrides;
  const sessionKeySuffix = transcriptSessionId.replace(/^internal-/u, "");
  return createRunEntry({
    cleanup: "delete",
    spawnMode: "run",
    ...recordOverrides,
    execution: {
      status: "terminal",
      endedAt: 4_000,
      transcriptTarget: {
        agentId: "main",
        sessionId: transcriptSessionId,
        sessionKey: `agent:main:internal:${sessionKeySuffix}`,
        storePath: "/tmp/openclaw-agent.sqlite",
      },
      ...execution,
    },
  });
}

export function makeSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return {
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status: "ok" },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: false,
    ...overrides,
  };
}

export function makeKilledSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "agent run aborted" },
    reason: SUBAGENT_ENDED_REASON_KILLED,
    ...overrides,
  });
}

export function makeInterruptedSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "restart interrupted run" },
    reason: SUBAGENT_ENDED_REASON_ERROR,
    recoverInterrupted: true,
    ...overrides,
  });
}

export function buildExpectedAnnounceIdempotencyKey(entry: SubagentRunRecord): string {
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
}

export function completeRun(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
) {
  return controller.completeSubagentRun(makeSubagentCompletion(entry, overrides));
}

export async function completeAndJoinCleanup(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
) {
  const join = observeRootWork();
  try {
    await completeRun(controller, entry, overrides);
  } finally {
    await join();
  }
}

export function finishCleanup(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  overrides: Partial<Parameters<LifecycleController["completeCleanupBookkeeping"]>[0]> = {},
) {
  return controller.completeCleanupBookkeeping({
    runId: entry.runId,
    entry,
    cleanup: "keep",
    completedAt: 5_000,
    ...overrides,
  });
}

export function settleRequesterTurn(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  requesterYielded = true,
) {
  return controller.settleRequesterTurnAfterSessionSpawns({
    requesterSessionKey: entry.requesterSessionKey,
    requesterTurnRunId: "run-requester",
    requesterYielded,
    acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
  });
}
