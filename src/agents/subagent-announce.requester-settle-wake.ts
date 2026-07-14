/**
 * Requester settle wake: wakes a registry-less top-level requester once its
 * last spawned child reaches a terminal settle. Split from subagent-announce
 * so the announce module stays within the max-lines budget; the wake owns its
 * own registry-runtime seam and the retired-row ledger.
 */
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { logWarn } from "../logger.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  buildChildCompletionFindings,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
} from "./subagent-announce-output.js";
import { hasUsableSessionEntry } from "./subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-announce.registry.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

type RequesterSettleWakeDeps = {
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};

const defaultRequesterSettleWakeDeps: RequesterSettleWakeDeps = {
  loadSubagentRegistryRuntime,
};

let requesterSettleWakeDeps: RequesterSettleWakeDeps = defaultRequesterSettleWakeDeps;

export const testing = {
  setDepsForTest(overrides?: Partial<RequesterSettleWakeDeps>) {
    requesterSettleWakeDeps = overrides
      ? { ...defaultRequesterSettleWakeDeps, ...overrides }
      : defaultRequesterSettleWakeDeps;
  },
};

type SettledRunSummary = Pick<
  SubagentRunRecord,
  "runId" | "childSessionKey" | "createdAt" | "startedAt" | "endedAt"
>;

// The settle wake is the only thing that ever fires after a fan-out drains,
// so a wake turn lost to a transient infra failure (provider stall, model
// timeout) would re-park the requester permanently. Bounded retries with a
// fresh idempotency suffix per attempt (the gateway dedupe caches terminal
// run outcomes, so re-dispatching the same key would no-op) keep the wake
// exactly-once per batch in the success path while surviving flaky turns.
const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;

function waitForRequesterSettleWakeRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// Delete-cleanup removes a child's registry row in the same cleanup pass that
// schedules the settle wake, and earlier delete-mode siblings vanished at
// their own settles — so a drained delete-mode wave cannot be reconstructed
// from registry rows alone (empty batch, no wake). Settled records whose row
// is already gone are remembered here until their wave's wake delivers (or
// fails terminally), keeping the batch and its idempotency key identical to
// the keep-mode outcome. In-memory only: after a restart the wake falls back
// to whichever rows survive, and entries expire so a requester that never
// drains does not accumulate rows forever.
const REQUESTER_SETTLE_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const settledRunLedger = new Map<
  string,
  Map<string, { entry: SubagentRunRecord; recordedAt: number }>
>();

function pruneSettledRunLedger(nowMs: number): void {
  for (const [requesterKey, runs] of settledRunLedger) {
    for (const [runId, record] of runs) {
      if (nowMs - record.recordedAt > REQUESTER_SETTLE_LEDGER_TTL_MS) {
        runs.delete(runId);
      }
    }
    if (runs.size === 0) {
      settledRunLedger.delete(requesterKey);
    }
  }
}

function recordSettledRunWithoutRegistryRow(
  requesterSessionKey: string,
  entry: SubagentRunRecord,
): void {
  let runs = settledRunLedger.get(requesterSessionKey);
  if (!runs) {
    runs = new Map();
    settledRunLedger.set(requesterSessionKey, runs);
  }
  runs.set(entry.runId, { entry, recordedAt: Date.now() });
}

function clearSettledRunLedgerEntries(
  requesterSessionKey: string,
  batch: readonly SubagentRunRecord[],
): void {
  const runs = settledRunLedger.get(requesterSessionKey);
  if (!runs) {
    return;
  }
  for (const entry of batch) {
    runs.delete(entry.runId);
  }
  if (runs.size === 0) {
    settledRunLedger.delete(requesterSessionKey);
  }
}

export function resetRequesterSettleLedgerForTests(): void {
  settledRunLedger.clear();
}

// Two runs are part of the same parallel wave when their lifetimes overlap.
// A strictly sequential child (spawned after its predecessor ended) never
// overlaps, which keeps the settle wake away from one-at-a-time usage.
function runIntervalsOverlap(a: SettledRunSummary, b: SettledRunSummary): boolean {
  const aStart = a.startedAt ?? a.createdAt;
  const bStart = b.startedAt ?? b.createdAt;
  const aEnd = typeof a.endedAt === "number" ? a.endedAt : Number.MAX_SAFE_INTEGER;
  const bEnd = typeof b.endedAt === "number" ? b.endedAt : Number.MAX_SAFE_INTEGER;
  return aStart <= bEnd && bStart <= aEnd;
}

function buildRequesterSettleWakeMessage(params: { findings?: string }): string {
  return [
    "[Subagent Context] Every subagent spawned from this session has now settled — none are still running or awaiting completion delivery.",
    "[Subagent Context] Do not keep waiting or call sessions_yield again for this batch; no further completion events will arrive.",
    "[Subagent Context] Review the completion results and send your consolidated final answer to the user now.",
    `[Subagent Context] Reply ONLY: ${SILENT_REPLY_TOKEN} only if you already delivered the consolidated final answer for this batch.`,
    "",
    params.findings ??
      "(each child result was announced individually in earlier completion events)",
  ].join("\n");
}

/**
 * Wakes a registry-less top-level requester once its last spawned child
 * reaches a terminal settle (announce delivered, given up, or suspended).
 *
 * Nested orchestrators are excluded: an orchestrator that is itself a subagent
 * has a run record and is woken through `wakeSubagentRunAfterDescendants` /
 * `wakeOnDescendantSettle`. A top-level chat session has no run record, so
 * without this wake it only ever receives the passive per-child announces and
 * can park indefinitely after the final one (mis-tracking "who is still out",
 * or never hearing about children whose announce gave up).
 */
export async function maybeWakeRequesterAfterAllChildrenSettled(params: {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  settledEntry: SubagentRunRecord;
  /**
   * Set by cleanup paths that retire the settling run's registry row in the
   * same pass that schedules this wake (cleanup="delete" and the reconciled
   * killed-row retire). The row is ledgered before the first await so every
   * concurrent last-sibling settle computes the same batch and idempotency
   * key — the guarantee keep-mode gets from rows persisting in the registry.
   */
  settledRowRetired?: boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return false;
  }
  if (isCronSessionKey(requesterSessionKey)) {
    return false;
  }
  pruneSettledRunLedger(Date.now());
  if (params.settledRowRetired === true) {
    recordSettledRunWithoutRegistryRow(requesterSessionKey, params.settledEntry);
  }

  // This runs on every child-run settle fleet-wide, so the in-memory registry
  // gating comes first; session-store reads (depth, requester entry) are
  // deferred until a drained wave actually qualifies for a wake.
  let registryRuntime: Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>;
  try {
    registryRuntime = await requesterSettleWakeDeps.loadSubagentRegistryRuntime();
  } catch {
    return false;
  }
  if (
    typeof registryRuntime.hasDescendantRunAwaitingSettle !== "function" ||
    typeof registryRuntime.listSubagentRunsForRequester !== "function"
  ) {
    return false;
  }
  const requesterRuns = registryRuntime.listSubagentRunsForRequester(requesterSessionKey);
  const listedRuns = Array.isArray(requesterRuns) ? requesterRuns : [];
  // Fallback for rows that vanished without the retire hint (e.g. swept
  // between settle and wake): ledger the in-hand record so a non-last
  // sibling's settle (which returns at the drain gate below) still
  // contributes its row to the eventual wave batch.
  if (
    !settledRunLedger.get(requesterSessionKey)?.has(params.settledEntry.runId) &&
    !listedRuns.some((entry) => entry.runId === params.settledEntry.runId)
  ) {
    recordSettledRunWithoutRegistryRow(requesterSessionKey, params.settledEntry);
  }

  // Race-safe drain check: exclude the settling run itself — its terminal
  // bookkeeping may not be visible yet when this fires from the finalize path.
  if (
    registryRuntime.hasDescendantRunAwaitingSettle(requesterSessionKey, params.settledEntry.runId)
  ) {
    return false;
  }

  // The wake batch is the parallel wave the settling child belonged to: the
  // connected component of lifetime overlaps seeded at the settling run.
  // Membership is transitive, not direct-overlap-only — in a staggered
  // fan-out where A overlaps B and B overlaps C but A never overlaps C, the
  // wake fired at C's settle must still carry A's results, and every possible
  // last-settler must compute the same component so the idempotency key stays
  // batch-stable. Children from earlier spawns whose lifetimes never chain
  // into this wave stay out, so a later one-off completion does not keep
  // re-waking the requester about old results. The runId match keeps the
  // settling run itself in the batch even when its own recorded timestamps
  // are inconsistent (endedAt before startedAt), where self-overlap would be
  // false.
  // Candidates: ended registry rows plus ledgered records whose rows were
  // already deleted. A registry row wins over a ledgered copy of the same run.
  const candidatesByRunId = new Map<string, SubagentRunRecord>();
  const ledgeredRuns = settledRunLedger.get(requesterSessionKey);
  for (const record of ledgeredRuns?.values() ?? []) {
    candidatesByRunId.set(record.entry.runId, record.entry);
  }
  for (const entry of listedRuns) {
    if (hasSubagentRunEnded(entry)) {
      candidatesByRunId.set(entry.runId, entry);
    }
  }
  const unclaimed = new Set(candidatesByRunId.values());
  const settledBatch: SubagentRunRecord[] = [];
  const frontier: SettledRunSummary[] = [params.settledEntry];
  for (const entry of unclaimed) {
    if (entry.runId === params.settledEntry.runId) {
      unclaimed.delete(entry);
      settledBatch.push(entry);
      frontier.push(entry);
      break;
    }
  }
  for (let pivot = frontier.pop(); pivot; pivot = frontier.pop()) {
    for (const entry of unclaimed) {
      if (runIntervalsOverlap(entry, pivot)) {
        unclaimed.delete(entry);
        settledBatch.push(entry);
        frontier.push(entry);
      }
    }
  }
  if (settledBatch.length === 0) {
    return false;
  }
  // Keep the wake out of the already-working paths: a single required child
  // whose completion announce was delivered carried its result into a
  // requester turn, and fire-and-forget children never promised delivery.
  // Fan-outs (N >= 2 required completions) need the wake even when every
  // announce was delivered — the incident class is the requester mis-tracking
  // outstanding children across turns — and any undelivered required
  // completion needs it because the requester never heard the result at all.
  // These two exits decline to wake for a wave that has fully drained, so its
  // ledgered rows can never join a later wake batch (a child spawned after
  // the drain cannot lifetime-overlap rows that already ended) — release them
  // now instead of holding child-result snapshots for the TTL.
  const requiredSettled = settledBatch.filter((entry) => entry.expectsCompletionMessage === true);
  if (requiredSettled.length === 0) {
    clearSettledRunLedgerEntries(requesterSessionKey, settledBatch);
    return false;
  }
  const hasUndeliveredRequiredCompletion = requiredSettled.some(
    (entry) => entry.delivery?.status !== "delivered",
  );
  if (requiredSettled.length < 2 && !hasUndeliveredRequiredCompletion) {
    clearSettledRunLedgerEntries(requesterSessionKey, settledBatch);
    return false;
  }

  // Scope guard: nested orchestrators (depth >= 1) are owned by the
  // descendant-settle wake; this wake is only for the registry-less top level.
  // Their ledgered rows are dropped here — this wake never fires for them, so
  // holding the records for the TTL would only accumulate memory fleet-wide.
  if (getSubagentDepthFromSessionStore(requesterSessionKey) >= 1) {
    clearSettledRunLedgerEntries(requesterSessionKey, settledBatch);
    return false;
  }
  const { entry: requesterEntry } = loadRequesterSessionEntry(requesterSessionKey);
  if (!hasUsableSessionEntry(requesterEntry)) {
    clearSettledRunLedgerEntries(requesterSessionKey, settledBatch);
    return false;
  }

  const findings = buildChildCompletionFindings(
    dedupeLatestChildCompletionRows(
      filterCurrentDirectChildCompletionRows(settledBatch, {
        requesterSessionKey,
        getLatestSubagentRunByChildSessionKey:
          registryRuntime.getLatestSubagentRunByChildSessionKey,
      }),
    ),
  );
  const wakeMessage = buildRequesterSettleWakeMessage({ findings });
  // One wake per drained batch: concurrent last-sibling settles compute the
  // same signature and dedupe on the idempotency key instead of double-waking.
  const batchSignature = settledBatch
    .map((entry) => entry.runId)
    .toSorted()
    .join(",");
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const directOrigin = resolveAnnounceOrigin(requesterEntry, requesterSessionOrigin);
  const wakeKeyBase = `requester-settle:${requesterSessionKey}:${batchSignature}`;

  for (let attempt = 0; attempt < REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS; attempt += 1) {
    if (params.signal?.aborted) {
      return false;
    }
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey,
      triggerMessage: wakeMessage,
      steerMessage: wakeMessage,
      summaryLine: "all spawned subagents settled",
      requesterSessionOrigin,
      requesterOrigin: requesterSessionOrigin,
      directOrigin,
      sourceSessionKey: params.settledEntry.childSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "subagent_announce",
      targetRequesterSessionKey: requesterSessionKey,
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: buildAnnounceIdempotencyKey(
        attempt === 0 ? wakeKeyBase : `${wakeKeyBase}:retry-${attempt}`,
      ),
      signal: params.signal,
    });
    if (delivery.delivered) {
      clearSettledRunLedgerEntries(requesterSessionKey, settledBatch);
      return true;
    }
    // A legitimately silent wake reply counts as delivered above; only real
    // delivery failures reach here. Terminal failures and an abandoned
    // requester will not improve on retry. Transient exhaustion (below) keeps
    // the ledgered rows so a later sibling settle can re-attempt the wake.
    if (delivery.terminal === true || delivery.reason === "requester_abandoned") {
      clearSettledRunLedgerEntries(requesterSessionKey, settledBatch);
      return false;
    }
    const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attempt];
    if (retryDelayMs === undefined) {
      break;
    }
    logWarn(
      `requester settle wake attempt ${attempt + 1} failed for ${requesterSessionKey}; ` +
        `retrying in ${Math.round(retryDelayMs / 1000)}s: ${delivery.error ?? delivery.reason ?? "undelivered"}`,
    );
    await waitForRequesterSettleWakeRetry(retryDelayMs);
  }
  return false;
}
