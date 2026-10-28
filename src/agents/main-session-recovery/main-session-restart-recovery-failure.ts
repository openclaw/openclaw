import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInternalMetadataForDisplay } from "../../auto-reply/reply/display-text-sanitize.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { buildUpdatedSessionGoalStatus } from "../../config/sessions/goals-transitions.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../../config/sessions/restart-recovery-types.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readRestartRecoveryRequesterSource } from "../requester-run-recovery-source.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import {
  transitionMainSessionRecovery,
  type MainSessionRecoveryObservation,
} from "./main-session-recovery-state.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-recovery-delivery.js";
import {
  mainSessionRecoveryLog,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";

/** Retire only the interrupted input; a fresh authenticated turn can use the same session. */
export async function prepareRequesterRestartRecovery(params: {
  agentId: string;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  sessionKey: string;
  storePath: string;
  assertCurrent: () => void;
  gatewayRuntime: GatewayRecoveryRuntime;
  sourceRunId: string;
  requesterSessionKey: string;
}): Promise<
  | { outcome: "ready"; source: SessionSourceAssertion }
  | { outcome: "settled" | "changed" | "failed" }
> {
  const { entry } = params;
  const { prepareRequesterSettleWakeRecoverySource } =
    await import("../subagents/registry/subagent-registry.js");
  params.assertCurrent();
  const recovered = await prepareRequesterSettleWakeRecoverySource({
    runId: params.sourceRunId,
    requesterSessionKey: params.requesterSessionKey,
    requesterAgentId: params.agentId,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    storePath: params.storePath,
    gatewayRuntime: params.gatewayRuntime,
    requesterOperatorSourceMissing:
      (!entry.restartRecoveryOperatorSource && !readRestartRecoveryRequesterSource(params)) ||
      undefined,
  });
  params.assertCurrent();
  if (recovered?.status === "ready") {
    return { outcome: "ready", source: recovered.source };
  }
  const settlement = {
    ...params,
    reason: recovered?.reason ?? "the original completion cohort is no longer available",
  };
  if (!entry.spawnedBy) {
    return await settleInterruptedRestartRecovery(settlement);
  }
  const outcome = await tombstoneMainRestartRecoveryWithNotice(settlement);
  return {
    outcome: outcome === "notice_failed" ? "failed" : outcome === "skipped" ? "changed" : "settled",
  };
}

/** Publish one local interruption notice and retire the exact input without replay or delivery. */
async function settleInterruptedRestartRecovery(params: {
  agentId?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  observation?: MainSessionRecoveryObservation;
  sessionKey: string;
  storePath: string;
  assertCurrent: () => void;
  reason: string;
  cronOwned?: boolean;
  terminalRunId?: string;
  terminalStatus?: "failed" | "timeout" | "killed";
  terminalDeliveryEvidence?: RestartRecoveryTerminalDeliveryEvidenceResult;
  clearRecoveryState?: boolean;
}): Promise<{ outcome: "settled" | "changed" | "failed" }> {
  const { entry, reason } = params;
  // Legacy interrupted inputs can lack both run IDs. The recovery cycle still
  // identifies their settlement; this receipt never authorizes execution.
  const terminalRunId =
    params.terminalRunId ??
    entry.restartRecoveryDeliveryRunId ??
    entry.restartRecoveryDeliverySourceRunId ??
    `main-session-restart-recovery:${params.observation?.cycleId}:interrupted`;
  const endedAt = Date.now();
  const goal =
    entry.goal?.status === "active" && entry.goal.updatedAt <= endedAt
      ? buildUpdatedSessionGoalStatus(
          entry,
          {
            status: "paused",
            note: "Paused after restart recovery failed. Resume to continue. " + reason,
          },
          endedAt,
        )
      : undefined;
  const capturedReply =
    entry.pendingFinalDelivery?.kind === "replayable"
      ? stripInternalMetadataForDisplay(entry.pendingFinalDelivery.text).trim()
      : undefined;
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    expectedSessionId: entry.sessionId,
    expectedLifecycleRevision: entry.lifecycleRevision ?? null,
    expectedSessionState: {
      ...buildRestartRecoveryExpectedState(entry, params.observation),
      ...(goal ? { goal: entry.goal } : {}),
      pendingFinalDelivery: entry.pendingFinalDelivery ?? null,
    },
    assertCurrent: params.assertCurrent,
    idempotencyKey: `main-session-restart-recovery:${entry.restartRecoveryDeliverySourceRunId ?? terminalRunId}:interrupted`,
    text:
      (params.cronOwned
        ? "The scheduled turn was interrupted by a Gateway restart. Cron owns its continuation; check the job history for its retry or interruption outcome. Your session and transcript are preserved."
        : `This interrupted turn could not resume after the Gateway restarted: ${reason}. ` +
          "Your session and transcript are preserved. Send a new authenticated message to continue.") +
      (capturedReply ? `\n\nSaved reply (delivery unconfirmed):\n${capturedReply}` : ""),
    sessionLifecyclePatch: {
      ...buildMainSessionRecoverySettlementPatch({
        entry,
        recordTerminalSource: true,
        terminalRunId,
        terminalDeliveryEvidence: params.terminalDeliveryEvidence,
        clearRecoveryState: params.clearRecoveryState,
      }),
      ...(goal ? { goal } : {}),
      status: params.terminalStatus ?? "interrupted",
      pendingFinalDelivery: undefined,
      lifecycleRunId: undefined,
      lastRunId: resolveRestartRecoveryTerminalClientRunId(entry) ?? terminalRunId,
      lastRunError: reason,
      endedAt,
      runtimeMs: Math.max(0, endedAt - (entry.startedAt ?? endedAt)),
      updatedAt: endedAt,
    },
  });
  if (result.ok) {
    await notifyInterruptedChildParent(params);
    return { outcome: "settled" };
  }
  if ("code" in result && result.code === "session-rebound") {
    return { outcome: "changed" };
  }
  mainSessionRecoveryLog.warn(
    `failed to settle interrupted recovery ${params.sessionKey}: ${result.reason}`,
  );
  return { outcome: "failed" };
}

/** A failed legacy continuation consumes its saved final, not another delivery owner's intent. */
export async function settleTerminalPendingFinalRecovery(
  params: MainSessionRecoveryStoreTarget & {
    expectedSessionId: string;
    pendingFinalDelivery: SessionEntry["pendingFinalDelivery"];
    runId: string;
    status: "failed" | "timeout" | "killed";
    terminalDeliveryEvidence?: RestartRecoveryTerminalDeliveryEvidenceResult;
    assertCurrent: () => void;
  },
): Promise<boolean> {
  const pending = params.pendingFinalDelivery;
  if (pending?.kind !== "replayable" || pending.intentId || pending.deliveries?.length) {
    return false;
  }
  const entry = await readSessionEntryReadOnlyInWorker(params, params.assertCurrent);
  if (
    !entry ||
    entry.sessionId !== params.expectedSessionId ||
    entry.abortedLastRun === true ||
    entry.restartRecoveryHarnessCompletion ||
    (entry.restartRecoveryDeliveryRunId !== params.runId &&
      !(
        entry.lifecycleRunId === params.runId && hasRestartRecoveryTerminalRun(entry, params.runId)
      )) ||
    !isDeepStrictEqual(entry.pendingFinalDelivery, {
      ...pending,
      text: stripInternalMetadataForDisplay(pending.text),
    }) ||
    entry.restartRecoveryRuns?.some(
      (run) =>
        run.runId !== params.runId &&
        run.runId !== entry.restartRecoveryDeliverySourceRunId &&
        !hasRestartRecoveryTerminalRun(entry, run.runId),
    )
  ) {
    return false;
  }
  const result = await settleInterruptedRestartRecovery({
    ...params,
    entry,
    terminalRunId: params.runId,
    terminalStatus: params.status,
    // Queued foreground inputs can own the cycle before registering a run fence.
    clearRecoveryState:
      !entry.mainRestartRecovery?.foregroundClaims && !entry.mainRestartRecovery?.reservation,
    reason: "the recovery turn ended without completing the saved final reply",
  });
  return result.outcome === "settled";
}

/** A terminal placement settles the saved turn without entering a worker dispatch lane. */
export async function settleFailedWorkerRestartRecovery(
  params: Omit<
    Parameters<typeof tombstoneMainRestartRecoveryWithNotice>[0],
    "reason" | "retireOwnerlessFinal"
  > & {
    placementSessionKey: string;
    shouldContinue?: () => boolean;
  },
): Promise<"settled" | "failed" | "skipped" | undefined> {
  const placement = await params.gatewayRuntime.prepareFailedWorkerPlacement({
    agentId: params.agentId,
    sessionId: params.entry.sessionId,
    sessionKey: params.placementSessionKey,
  });
  if (!placement) {
    return undefined;
  }
  const assertCurrent = () => {
    if (params.shouldContinue?.() === false || !placement.isCurrent()) {
      throw new Error("Failed worker placement changed before restart settlement");
    }
  };
  try {
    const outcome = await tombstoneMainRestartRecoveryWithNotice({
      ...params,
      reason: placement.reason,
      retireOwnerlessFinal: true,
      assertCurrent,
    });
    return outcome === "notice_failed" ? "failed" : outcome === "skipped" ? "skipped" : "settled";
  } finally {
    placement.release();
  }
}

/** Sender loss retires one input only when no other execution or delivery custody remains. */
export async function finishDelegatedRestartRecovery(
  params: Parameters<typeof tombstoneMainRestartRecoveryWithNotice>[0] & {
    assertCurrent: () => void;
    cronOwned?: boolean;
  },
): Promise<"notice_failed" | "skipped" | "tombstoned" | "settled"> {
  const { entry } = params;
  const unfinishedRuns = (entry.restartRecoveryRuns ?? []).filter(
    (run) => !hasRestartRecoveryTerminalRun(entry, run.runId),
  );
  // Cron can leave an older delivery-source claim beside its single interrupted
  // turn. Retire that residue so the scheduler can re-admit the conversation.
  // Multiple unfinished turns or pending delivery still retain their custody.
  if (
    // A child still owes its parent an outcome; retain the operator's Resume action.
    entry.spawnedBy ||
    entry.pendingFinalDelivery ||
    entry.restartRecoveryHarnessCompletion ||
    (!(params.cronOwned && unfinishedRuns.length <= 1) &&
      unfinishedRuns.some(
        (run) =>
          run.runId !== entry.restartRecoveryDeliveryRunId &&
          run.runId !== entry.restartRecoveryDeliverySourceRunId,
      ))
  ) {
    return await tombstoneMainRestartRecoveryWithNotice(params);
  }
  const result = await settleInterruptedRestartRecovery(params);
  return result.outcome === "failed"
    ? "notice_failed"
    : result.outcome === "changed"
      ? "skipped"
      : "settled";
}

/** Record the failed turn for its exact parent without starting another delegated turn. */
async function notifyInterruptedChildParent(
  params: Omit<Parameters<typeof settleInterruptedRestartRecovery>[0], "assertCurrent"> & {
    assertCurrent?: () => void;
  },
  resumeAvailable = false,
): Promise<boolean> {
  const parentKey = params.entry.spawnedBy;
  const parentId = params.entry.spawnedBySessionId;
  const parentRevision = params.entry.parentSessionLifecycleRevision;
  if (!parentKey || !parentId || !parentRevision) {
    return true;
  }
  try {
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg: params.cfg ?? getRuntimeConfig(),
      key: parentKey,
      agentId: resolveAgentIdFromSessionKey(parentKey, params.agentId),
      assertActive: params.assertCurrent,
    });
    const parent = target.store[target.canonicalKey];
    if (
      parent?.sessionId !== parentId ||
      parent.lifecycleRevision !== parentRevision ||
      parent.archivedAt !== undefined
    ) {
      return true;
    }
    const result = await appendAssistantMessageToSessionTranscript({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      expectedSessionId: parentId,
      expectedLifecycleRevision: parentRevision,
      assertCurrent: params.assertCurrent,
      idempotencyKey: `child-restart-interrupted:${params.entry.sessionId}:${params.entry.restartRecoveryDeliverySourceRunId ?? params.entry.restartRecoveryDeliveryRunId ?? params.terminalRunId ?? params.observation?.cycleId}`,
      text:
        `Child session ${params.sessionKey} could not resume its interrupted turn after the Gateway restarted: ${params.reason}. Its transcript is preserved. ` +
        (resumeAvailable
          ? "Open the child session and use Resume to continue under your current permissions."
          : "Send a new authenticated message to the child session to continue."),
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return true;
  } catch (error) {
    mainSessionRecoveryLog.warn(
      `failed to record child restart interruption for parent ${parentKey}: ${String(error)}`,
    );
    return false;
  }
}

function buildTombstonedSessionNotice(reason: string): string {
  return (
    `I couldn't continue this session after a gateway restart: ${reason}. ` +
    "Your transcript is safe. In WebChat, use Resume to continue in this session; " +
    "in other channels, use /new or /reset to start a replacement session, then describe the unfinished work."
  );
}

function buildRestartRecoveryTombstoneNoticeKey(entry: SessionEntry): string {
  const interruptedRunId =
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ??
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ??
    entry.sessionId;
  return `main-session-restart-recovery:${interruptedRunId}:failed-notice`;
}

export async function tombstoneMainRestartRecoveryWithNotice(params: {
  agentId: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  observation: MainSessionRecoveryObservation;
  reason: string;
  retireOwnerlessFinal?: true;
  sessionKey: string;
  storePath: string;
  assertCurrent?: () => void;
}): Promise<"notice_failed" | "skipped" | "tombstoned"> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  const { entry, observation } = params;
  const tombstoned = { ...entry };
  const endedAt = Date.now();
  const transition = transitionMainSessionRecovery(tombstoned, {
    kind: "tombstone",
    now: endedAt,
    observation,
    reason: params.reason,
  });
  if (transition.kind !== "tombstoned") {
    return "skipped";
  }
  const goal =
    entry.goal?.status === "active" && entry.goal.updatedAt <= endedAt
      ? buildUpdatedSessionGoalStatus(
          entry,
          {
            status: "paused",
            note: "Paused after restart recovery failed. Resume to continue. " + params.reason,
          },
          endedAt,
        )
      : undefined;
  // Keep automatic recovery pending until its parent outcome is durable. A restart
  // between these writes retries the same notice through its idempotency key.
  if (!(await notifyInterruptedChildParent(params, true))) {
    return "notice_failed";
  }
  const pending = entry.pendingFinalDelivery;
  const retirePending =
    params.retireOwnerlessFinal === true &&
    pending?.kind === "replayable" &&
    !pending.intentId &&
    !pending.deliveries?.length;
  const capturedReply = retirePending ? stripInternalMetadataForDisplay(pending.text).trim() : "";
  // Failed placements save an ownerless final before retiring its replay marker.
  // Other tombstones retain the saved delivery obligation.
  // Identified delivery remains with its owner; a new turn cannot discard it.
  const result = await appendAssistantMessageToSessionTranscript({
    ...params,
    expectedSessionState: {
      ...buildRestartRecoveryExpectedState(entry, observation),
      ...(goal ? { goal: entry.goal } : {}),
      pendingFinalDelivery: pending ?? null,
    },
    sessionLifecyclePatch: {
      abortedLastRun: tombstoned.abortedLastRun,
      ...(goal ? { goal } : {}),
      endedAt: tombstoned.endedAt,
      lifecycleRunId: tombstoned.lifecycleRunId,
      lastRunId: tombstoned.lastRunId,
      mainRestartRecovery: tombstoned.mainRestartRecovery,
      pendingFinalDelivery: retirePending ? undefined : pending,
      runtimeMs: tombstoned.runtimeMs,
      status: tombstoned.status,
      updatedAt: tombstoned.updatedAt,
    },
    expectedSessionId: entry.sessionId,
    text:
      buildTombstonedSessionNotice(params.reason) +
      (capturedReply ? `\n\nSaved reply (delivery unconfirmed):\n${capturedReply}` : ""),
    idempotencyKey: buildRestartRecoveryTombstoneNoticeKey(entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    mainSessionRecoveryLog.warn(
      `failed to write restart recovery tombstone notice ${params.sessionKey}: ${result.reason}`,
    );
    return "notice_failed";
  }
  if (!deliveryContext) {
    return "tombstoned";
  }
  mainSessionRecoveryLog.warn(
    `tombstoned main-session restart recovery: ${params.sessionKey} (${params.reason})`,
  );
  const { gatewayRuntime, reason, sessionKey } = params;
  try {
    params.assertCurrent?.();
    await gatewayRuntime.sendRecoveryNotice({
      channel: deliveryContext.channel,
      to: deliveryContext.to,
      accountId: deliveryContext.accountId,
      threadId: deliveryContext.threadId,
      text: buildTombstonedSessionNotice(reason),
      idempotencyKey: buildRestartRecoveryTombstoneNoticeKey(tombstoned),
    });
    mainSessionRecoveryLog.info(
      `sent restart recovery tombstone notice: ${sessionKey} (${reason})`,
    );
  } catch (error) {
    mainSessionRecoveryLog.warn(
      `failed to send restart recovery tombstone notice ${sessionKey}: ${String(error)}`,
    );
  }
  return "tombstoned";
}
