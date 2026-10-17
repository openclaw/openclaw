/** Normalizes accepted child-session spawn results from loose tool payloads. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";

// Helpers for recognizing accepted session-spawn tool results.
export type AcceptedSessionSpawn = {
  runId: string;
  childSessionKey: string;
  sessionUrl?: string;
  publicRead?: boolean;
  label?: string;
  /** True only when this child owns a terminal completion for its requester. */
  expectsCompletionMessage?: boolean;
  /** Host-recorded: this run's agents_wait returned the collector's result as done. */
  collected?: true;
};

// Accounting follows the exact admission through provider fallback and plugin
// refresh. A reused run ID must never inherit another operational instance's children.
const acceptedSpawnsByRun = resolveGlobalSingleton(
  Symbol.for("openclaw.acceptedSessionSpawnsByRun"),
  () => new WeakMap<OperationalRunInstanceRef, Map<string, AcceptedSessionSpawn>>(),
);

export function mergeAcceptedSessionSpawnsForRun(
  instance: OperationalRunInstanceRef,
  accepted: readonly AcceptedSessionSpawn[] = [],
): AcceptedSessionSpawn[] {
  let receipts = acceptedSpawnsByRun.get(instance);
  if (!receipts && accepted.length > 0) {
    receipts = new Map();
    acceptedSpawnsByRun.set(instance, receipts);
  }
  for (const spawn of accepted) {
    // Acceptance is immutable for this run; later harness projections cannot
    // erase the producer's completion obligation. Collection only adds evidence.
    const receipt = receipts?.get(spawn.runId);
    receipts?.set(
      spawn.runId,
      receipt && spawn.collected && !receipt.collected
        ? { ...receipt, collected: true }
        : (receipt ?? spawn),
    );
  }
  return receipts ? [...receipts.values()] : [];
}

/** Normalize a tool result that accepted a child session spawn. */
export function normalizeAcceptedSessionSpawnResult(result: unknown): AcceptedSessionSpawn | null {
  const details = asOptionalRecord(asOptionalRecord(result)?.details);
  if (!details || details.status !== "accepted") {
    return null;
  }
  const runId = normalizeOptionalString(details.runId);
  const childSessionKey = normalizeOptionalString(details.childSessionKey);
  if (!runId || !childSessionKey) {
    return null;
  }
  const sessionUrl = normalizeOptionalString(details.sessionUrl);
  const url = sessionUrl ? URL.parse(sessionUrl) : null;
  const label = normalizeOptionalString(details.label);
  return {
    runId,
    childSessionKey,
    ...(url?.protocol === "http:" || url?.protocol === "https:" ? { sessionUrl } : {}),
    ...(label ? { label } : {}),
    ...(details.publicRead === true ? { publicRead: true } : {}),
    expectsCompletionMessage: details.expectsCompletionMessage === true,
  };
}

/** Return true when a collection contains at least one accepted child spawn. */
export function hasAcceptedSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return Boolean(acceptedSessionSpawns?.length);
}

/** Read the collector run IDs an agents_wait result returned as done. */
export function readCollectedRunIds(result: unknown): string[] {
  const completed = asOptionalRecord(asOptionalRecord(result)?.details)?.completed;
  if (!Array.isArray(completed)) {
    return [];
  }
  return completed.flatMap((entry) => {
    const record = asOptionalRecord(entry);
    const runId = normalizeOptionalString(record?.runId);
    return record?.status === "done" && runId ? [runId] : [];
  });
}

/** Mark accepted collectors whose results agents_wait returned as done. */
export function markCollectedSessionSpawns(
  acceptedSessionSpawns: AcceptedSessionSpawn[],
  collectedRunIds: readonly string[],
): void {
  for (const [index, spawn] of acceptedSessionSpawns.entries()) {
    if (collectedRunIds.includes(spawn.runId)) {
      acceptedSessionSpawns[index] = { ...spawn, collected: true };
    }
  }
}

/** Mark collectors that an earlier attempt of this run accepted. */
export function markCollectedSessionSpawnsForRun(
  instance: OperationalRunInstanceRef,
  collectedRunIds: readonly string[],
): void {
  const receipts = acceptedSpawnsByRun.get(instance);
  for (const runId of collectedRunIds) {
    const receipt = receipts?.get(runId);
    if (receipt && !receipt.collected) {
      receipts?.set(runId, { ...receipt, collected: true });
    }
  }
}

/** Return true when an accepted child still owns work this run has not collected. */
export function hasUncollectedSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  const collected = new Set(
    acceptedSessionSpawns?.filter((spawn) => spawn.collected).map((spawn) => spawn.runId),
  );
  return (
    acceptedSessionSpawns?.some(
      (spawn) => spawn.expectsCompletionMessage === true || !collected.has(spawn.runId),
    ) === true
  );
}

/** Return true when an accepted child owns the requester's terminal completion. */
export function hasCompletionMessageSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return acceptedSessionSpawns?.some((spawn) => spawn.expectsCompletionMessage === true) === true;
}
