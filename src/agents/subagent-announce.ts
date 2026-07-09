/**
 * Subagent completion announcement coordinator.
 *
 * Captures child output, applies wait outcomes, routes announcements, and performs cleanup decisions.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../auto-reply/tokens.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  runAnnounceDeliveryWithRetry,
  resolveSubagentAnnounceTimeoutMs,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  applySubagentWaitOutcome,
  buildChildCompletionFindings,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  type SubagentRunOutcome,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  getRuntimeConfig,
  waitForEmbeddedAgentRunEnd,
} from "./subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  loadSubagentRegistryRuntime,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-announce.registry.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type). Reply ONLY: ${SILENT_REPLY_TOKEN} only when this exact result is already visible to the user in this same turn.`;
  }
  return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

function hasUsableSessionEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const sessionId = (entry as { sessionId?: unknown }).sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

function buildDescendantWakeMessage(params: { findings: string; taskLabel: string }): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}

const WAKE_RUN_SUFFIX = ":wake";

function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

function isWakeContinuationRun(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
}

function stripAndClassifyReply(text: string): string | null {
  let result = text;
  let didStrip = false;
  const hasLeadingSilentToken = startsWithSilentToken(result, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    result = stripLeadingSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (hasLeadingSilentToken || result.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    result = stripSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (
    didStrip &&
    (!result.trim() || isSilentReplyText(result, SILENT_REPLY_TOKEN) || isAnnounceSkip(result))
  ) {
    return null;
  }
  return result;
}

async function wakeSubagentRunAfterDescendants(params: {
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings: string;
  announceId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!hasUsableSessionEntry(childEntry)) {
    return false;
  }

  const cfg = subagentAnnounceDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });

  let wakeRunId;
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      signal: params.signal,
      run: async () =>
        await subagentAnnounceDeps.dispatchGatewayMethodInProcess(
          "agent",
          {
            sessionKey: params.childSessionKey,
            message: wakeMessage,
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: params.childSessionKey,
              sourceChannel: INTERNAL_MESSAGE_CHANNEL,
              sourceTool: "subagent_announce",
            },
            idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`),
          },
          {
            timeoutMs: announceTimeoutMs,
          },
        ),
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return false;
  }

  if (!wakeRunId) {
    return false;
  }

  const { replaceSubagentRunAfterSteer } = await loadSubagentRegistryRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: params.runId,
    nextRunId: wakeRunId,
    preserveFrozenResultFallback: true,
    // Persist the wake message as the replacement run's task so that any
    // post-restart redispatch reconstructs the correct prompt.
    task: wakeMessage,
  });
}

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
    registryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
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
  const requiredSettled = settledBatch.filter((entry) => entry.expectsCompletionMessage === true);
  if (requiredSettled.length === 0) {
    return false;
  }
  const hasUndeliveredRequiredCompletion = requiredSettled.some(
    (entry) => entry.delivery?.status !== "delivered",
  );
  if (requiredSettled.length < 2 && !hasUndeliveredRequiredCompletion) {
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

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /**
   * Fallback text preserved from the pre-wake run when a wake continuation
   * completes with NO_REPLY despite an earlier final summary already existing.
   */
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  onBeforeDeleteChildSession?: () => boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = loadSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedAgentRunActive(childSessionId)) {
      const settled = await waitForEmbeddedAgentRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedAgentRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
          return false;
        }
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const wait = await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs);
      const applied = applySubagentWaitOutcome({
        wait,
        outcome,
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      });
      outcome = applied.outcome;
      params.startedAt = applied.startedAt;
      params.endedAt = applied.endedAt;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }
    const failedTerminalOutcome = outcome.status === "error";
    const allowFailedOutputCapture =
      !failedTerminalOutcome || (!params.roundOneReply && !params.fallbackReply);
    if (failedTerminalOutcome) {
      reply = undefined;
    }
    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);

    let childCompletionFindings: string | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
      if (
        requesterDepth >= 1 &&
        subagentRegistryRuntime.shouldIgnorePostCompletionAnnounceForSession(
          targetRequesterSessionKey,
        )
      ) {
        return true;
      }

      const pendingChildDescendantRuns = Math.max(
        0,
        subagentRegistryRuntime.countPendingDescendantRuns(params.childSessionKey),
      );
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return false;
      }

      if (typeof subagentRegistryRuntime.listSubagentRunsForRequester === "function") {
        const directChildren = subagentRegistryRuntime.listSubagentRunsForRequester(
          params.childSessionKey,
          {
            requesterRunId: params.childRunId,
          },
        );
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          childCompletionFindings = buildChildCompletionFindings(
            dedupeLatestChildCompletionRows(
              filterCurrentDirectChildCompletionRows(directChildren, {
                requesterSessionKey: params.childSessionKey,
                getLatestSubagentRunByChildSessionKey:
                  subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey,
              }),
            ),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });

    const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
    if (
      params.wakeOnDescendantSettle === true &&
      childCompletionFindings?.trim() &&
      !childRunAlreadyWoken
    ) {
      const wakeAnnounceId = buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: stripWakeRunSuffixes(params.childRunId),
      });
      const woke = await wakeSubagentRunAfterDescendants({
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        taskLabel: params.label || params.task || "task",
        findings: childCompletionFindings,
        announceId: wakeAnnounceId,
        signal: params.signal,
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return true;
      }
    }

    if (!childCompletionFindings) {
      const fallbackReply = failedTerminalOutcome
        ? undefined
        : normalizeOptionalString(params.fallbackReply);
      const fallbackIsSilent =
        Boolean(fallbackReply) &&
        (isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));

      if (!reply && allowFailedOutputCapture) {
        reply = await readSubagentOutput(params.childSessionKey, outcome);
      }

      if (!reply?.trim() && allowFailedOutputCapture) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          maxWaitMs: params.timeoutMs,
          outcome,
        });
      }

      if (!reply?.trim() && fallbackReply && !fallbackIsSilent) {
        reply = fallbackReply;
      }

      // A worker can finish just after the first wait request timed out.
      // If we already have real completion content, do one cached recheck so
      // the final completion event prefers the authoritative terminal state.
      // This is best-effort; if the recheck fails, keep the known timeout
      // outcome instead of dropping the announcement entirely.
      if (outcome?.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) {
        try {
          const rechecked = await waitForSubagentRunOutcome(params.childRunId, 0);
          const applied = applySubagentWaitOutcome({
            wait: rechecked,
            outcome,
            startedAt: params.startedAt,
            endedAt: params.endedAt,
          });
          outcome = applied.outcome;
          params.startedAt = applied.startedAt;
          params.endedAt = applied.endedAt;
        } catch {
          // Best-effort recheck; keep the existing timeout outcome on failure.
        }
      }

      if (isAnnounceSkip(reply) || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        if (fallbackReply && !fallbackIsSilent) {
          const cleaned = stripAndClassifyReply(fallbackReply);
          if (cleaned === null) {
            if (isAnnounceSkip(reply) && isCronSessionKey(targetRequesterSessionKey)) {
              logWarn(
                `cron job completion for session=${targetRequesterSessionKey} ` +
                  `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
                  `the agent replied with the skip sentinel instead of delivering a result`,
              );
            }
            return true;
          }
          reply = cleaned;
        } else {
          if (isAnnounceSkip(reply) && isCronSessionKey(targetRequesterSessionKey)) {
            logWarn(
              `cron job completion for session=${targetRequesterSessionKey} ` +
                `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
                `the agent replied with the skip sentinel instead of delivering a result`,
            );
          }
          return true;
        }
      } else if (reply) {
        const cleaned = stripAndClassifyReply(reply);
        if (cleaned === null) {
          if (fallbackReply && !fallbackIsSilent) {
            const cleanedFallback = stripAndClassifyReply(fallbackReply);
            if (cleanedFallback === null) {
              return true;
            }
            reply = cleanedFallback;
          } else {
            return true;
          }
        } else {
          reply = cleaned;
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed; ready for parent review"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";
    const findings = childCompletionFindings || reply || "(no output)";

    let requesterIsSubagent = requesterIsInternalSession();
    if (requesterIsSubagent) {
      const {
        isSubagentSessionRunActive,
        resolveRequesterForChildSession,
        shouldIgnorePostCompletionAnnounceForSession,
      } = subagentRegistryRuntime ?? (await loadSubagentRegistryRuntime());
      if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
        if (shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) {
          return true;
        }
        const parentSessionEntry = loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive = hasUsableSessionEntry(parentSessionEntry);

        if (!parentSessionAlive) {
          const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
          if (!fallback?.requesterSessionKey) {
            shouldDeleteChildSession = false;
            return false;
          }
          targetRequesterSessionKey = fallback.requesterSessionKey;
          targetRequesterOrigin =
            normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
          requesterIsSubagent = requesterIsInternalSession();
        }
      }
    }

    const replyInstruction = buildAnnounceReplyInstruction({
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
    });
    const statsLine = await buildCompactAnnounceStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
    const internalEvents: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: announceType === "cron job" ? "cron" : "subagent",
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        announceType,
        taskLabel,
        status: outcome.status,
        statusLabel,
        result: findings,
        statsLine,
        replyInstruction,
      },
    ];
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);

    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = loadRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const completionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent
        ? await resolveSubagentCompletionOrigin({
            childSessionKey: params.childSessionKey,
            requesterSessionKey: targetRequesterSessionKey,
            requesterOrigin: directOrigin,
            childRunId: params.childRunId,
            spawnMode: params.spawnMode,
            expectsCompletionMessage,
          })
        : targetRequesterOrigin;
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      announceId,
      triggerMessage,
      steerMessage: triggerMessage,
      internalEvents,
      summaryLine: taskLabel,
      requesterSessionOrigin: targetRequesterOrigin,
      requesterOrigin:
        expectsCompletionMessage && !requesterIsSubagent
          ? completionDirectOrigin
          : targetRequesterOrigin,
      completionDirectOrigin,
      directOrigin,
      sourceSessionKey: params.childSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "subagent_announce",
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      signal: params.signal,
    });
    params.onDeliveryResult?.(delivery);
    didAnnounce = delivery.delivered || delivery.terminal === true;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.log(
        `[warn] Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (shouldDeleteChildSession && (params.onBeforeDeleteChildSession?.() ?? true)) {
      await deleteSubagentSessionForCleanup({
        callGateway: subagentAnnounceDeps.callGateway,
        childSessionKey: params.childSessionKey,
        spawnMode: params.spawnMode,
      });
    }
  }
  return didAnnounce;
}

export const testing = {
  setDepsForTest(
    overrides?: Partial<SubagentAnnounceDeps> & {
      callGateway?: typeof callGateway;
    },
  ) {
    const callGatewayOverride = overrides?.callGateway;
    const dispatchGatewayMethodInProcessOverride =
      overrides?.dispatchGatewayMethodInProcess ??
      (callGatewayOverride
        ? ((async (method, agentParams, options) =>
            await callGatewayOverride({
              method,
              params: agentParams,
              expectFinal: options?.expectFinal,
              timeoutMs: options?.timeoutMs,
            })) satisfies typeof dispatchGatewayMethodInProcess)
        : undefined);
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
          ...(dispatchGatewayMethodInProcessOverride
            ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
            : {}),
        }
      : defaultSubagentAnnounceDeps;
  },
};
