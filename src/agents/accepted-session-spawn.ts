/** Normalizes accepted child-session spawn results from loose tool payloads. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";

// Helpers for recognizing accepted session-spawn tool results.
export type AcceptedSessionSpawn = {
  runId: string;
  childSessionKey: string;
  /** True only when this child owns a terminal completion for its requester. */
  expectsCompletionMessage?: boolean;
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
    // erase the producer's completion obligation.
    receipts?.set(spawn.runId, receipts.get(spawn.runId) ?? spawn);
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
  return {
    runId,
    childSessionKey,
    expectsCompletionMessage: details.expectsCompletionMessage === true,
  };
}

/** Return true when a collection contains at least one accepted child spawn. */
export function hasAcceptedSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return Boolean(acceptedSessionSpawns?.length);
}

/** Return true when an accepted child owns the requester's terminal completion. */
export function hasCompletionMessageSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return acceptedSessionSpawns?.some((spawn) => spawn.expectsCompletionMessage === true) === true;
}
