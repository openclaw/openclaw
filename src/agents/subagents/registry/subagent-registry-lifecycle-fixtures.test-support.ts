/**
 * Completion-request fixtures shared by the lifecycle suite and its registered
 * case modules. Kept beside the suite so the test file stays within its line
 * cap and every case builds the same request shape.
 */
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentCompletionParams = Parameters<
  SubagentLifecycleController["completeSubagentRun"]
>[0];
type CompletionOverrides = Omit<Partial<SubagentCompletionParams>, "runId">;

export function makeSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: CompletionOverrides = {},
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
  overrides: CompletionOverrides = {},
): SubagentCompletionParams {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "agent run aborted" },
    reason: SUBAGENT_ENDED_REASON_KILLED,
    ...overrides,
  });
}

export function makeInterruptedSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: CompletionOverrides = {},
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
