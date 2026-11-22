import { randomUUID } from "node:crypto";
import type {
  WorkboardCard,
  WorkboardExecution,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  lifecycleStatusSourceUpdatedAtFromPatch,
  shouldSkipPersistedLifecycleStatusUpdate,
} from "./store-card-helpers.js";
import { MAX_CARD_NOTIFICATIONS } from "./store-constants.js";
import type { WorkboardCardPatch } from "./store-inputs.js";
import { trimMetadataToBudget } from "./store-normalizers.js";

export function finishRun(
  card: WorkboardCard,
  status: "done" | "blocked",
  now: number,
  reason?: string,
): { status: "done" | "blocked"; execution?: WorkboardExecution; metadata: WorkboardMetadata } {
  const execution =
    card.execution?.status === "running"
      ? { ...card.execution, status, updatedAt: now }
      : card.execution;
  return {
    status,
    ...(execution ? { execution } : {}),
    metadata: {
      ...card.metadata,
      claim: undefined,
      attempts: closeRunningAttempts(
        card.metadata?.attempts,
        now,
        status === "done" ? "succeeded" : "blocked",
        reason,
      ),
      failureCount: status === "done" ? 0 : (card.metadata?.failureCount ?? 0) + 1,
    },
  };
}

export function appendCardNotification(
  metadata: WorkboardMetadata | undefined,
  now: number,
  sequence: number,
  notification: Omit<WorkboardNotification, "id" | "createdAt" | "sequence">,
): WorkboardNotification[] {
  return [
    ...(metadata?.notifications ?? []),
    { id: randomUUID(), createdAt: now, sequence, ...notification },
  ].slice(-MAX_CARD_NOTIFICATIONS);
}

/** Returns the patch updateCard should apply, or undefined when a stale lifecycle write has nothing left. */
export function resolveLifecycleStatusWrite(
  existing: WorkboardCard,
  patch: WorkboardCardPatch,
): { effectivePatch: WorkboardCardPatch; hasFreshLifecycleStatusSource: boolean } | undefined {
  const lifecycleStatusSourceUpdatedAt = lifecycleStatusSourceUpdatedAtFromPatch(patch.metadata);
  const existingLifecycleStatusSourceUpdatedAt = existing.metadata?.lifecycleStatusSourceUpdatedAt;
  const hasFreshLifecycleStatusSource =
    lifecycleStatusSourceUpdatedAt !== undefined &&
    lifecycleStatusSourceUpdatedAt !== existingLifecycleStatusSourceUpdatedAt;
  let effectivePatch = patch;
  if (
    patch.status !== undefined &&
    lifecycleStatusSourceUpdatedAt !== undefined &&
    shouldSkipPersistedLifecycleStatusUpdate(existing, lifecycleStatusSourceUpdatedAt)
  ) {
    // Ignore stale lifecycle status writes, but still accept any non-status updates in the patch.
    effectivePatch = { ...patch, status: undefined };
    if (isRecord(patch.metadata)) {
      const { lifecycleStatusSourceUpdatedAt: _ignored, ...rest } = patch.metadata;
      effectivePatch.metadata = Object.keys(rest).length > 0 ? rest : undefined;
    }
    const hasSemanticPatch = Object.entries(effectivePatch).some(
      ([key, value]) => key !== "status" && key !== "metadata" && value !== undefined,
    );
    if (!hasSemanticPatch && effectivePatch.metadata === undefined) {
      return undefined;
    }
  }
  return { effectivePatch, hasFreshLifecycleStatusSource };
}

// Manual terminal writes share complete/block teardown. Already-ended runs only release
// their stale claim, without counting another failure or emitting another notification.
export function settleManualStatusTransition(params: {
  existing: WorkboardCard;
  status: WorkboardStatus;
  execution: WorkboardExecution | undefined;
  metadata: WorkboardMetadata;
  now: number;
  nextNotificationSequence: () => number;
  preserveProofId?: string;
}): { execution: WorkboardExecution | undefined; metadata: WorkboardMetadata } {
  const { existing, status, execution, now } = params;
  // Status patches often spread existing metadata. Only a newly supplied
  // lifecycle source is provenance; copied markers must not survive a manual transition.
  const metadata = { ...params.metadata, lifecycleStatusSourceUpdatedAt: undefined };
  if (status !== "done" && status !== "blocked") {
    return { execution, metadata };
  }
  const runActive =
    execution?.status === "running" ||
    metadata.attempts?.some((attempt) => attempt.status === "running");
  if (!runActive) {
    return { execution, metadata: metadata.claim ? { ...metadata, claim: undefined } : metadata };
  }
  const finished = finishRun({ ...existing, execution, metadata }, status, now);
  const notifications = appendCardNotification(
    finished.metadata,
    now,
    params.nextNotificationSequence(),
    {
      kind: status === "done" ? "completed" : "failed",
      message: `Workboard card moved to ${status}.`,
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    },
  );
  return {
    execution: finished.execution,
    metadata: trimMetadataToBudget(
      { ...finished.metadata, notifications },
      { preserveProofId: params.preserveProofId, preserveNotificationId: notifications.at(-1)?.id },
    ),
  };
}
