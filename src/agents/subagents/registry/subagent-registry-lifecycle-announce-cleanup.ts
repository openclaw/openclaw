import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../../runtime.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { loadSessionEntryByKey } from "../announce/subagent-announce-delivery.runtime.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import {
  ensureDeliveryState,
  getDeliveryLastError,
  isDeliverySuspended,
  clearSubagentPendingDelivery,
  loadPendingFinalDeliveryPayload,
} from "./subagent-delivery-state.js";
import {
  resolveAnnounceDeliveryDeadline,
  shouldSuspendPendingFinalDelivery,
} from "./subagent-registry-cleanup.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
} from "./subagent-registry-helpers.js";
import {
  retireSupersededCleanupIfNeeded,
  beginSubagentCleanup,
  runDetachedCleanupAttempt,
} from "./subagent-registry-lifecycle-attempt.js";
import {
  isSubagentCompletionDeliveryAllowed,
  retireSupersededCleanupInBackground,
  suspendPendingFinalDelivery,
} from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import {
  formatAnnounceDeliveryError,
  hasPriorRequesterDeliveryMirror,
  recordAnnounceDeliveryResult,
} from "./subagent-registry-lifecycle-delivery.js";
import { finalizeSubagentCleanup } from "./subagent-registry-lifecycle-finalize-cleanup.js";
import { finalizeResumedAnnounceGiveUp } from "./subagent-registry-lifecycle-give-up.js";
import {
  buildSafeLifecycleErrorMeta,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-log.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  assertSubagentRegistryWriteOutcomeKnown,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { hasRequesterCompletionCohort } from "./subagent-requester-settle-identity.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";

type RunSubagentAnnounceFlow =
  (typeof import("../announce/subagent-announce.js"))["runSubagentAnnounceFlow"];
type SubagentAnnounceFlowOutcome = Awaited<ReturnType<RunSubagentAnnounceFlow>>;

export const resumeAncestorCleanup = (
  context: SubagentLifecycleAnnounceCleanupContext,
  settledEntry: SubagentRunRecord,
) => {
  const params = context.options;
  const now = Date.now();
  const visited = [settledEntry];
  let requesterSessionKey = settledEntry.requesterSessionKey;
  let requesterAgentId = settledEntry.requesterAgentId;
  while (
    requesterSessionKey &&
    !visited.some((entry) =>
      matchesSubagentChildSessionOwner(entry, requesterSessionKey, requesterAgentId),
    )
  ) {
    const entry = params.getLatestRunForChildSession(
      requesterSessionKey,
      undefined,
      requesterAgentId,
    );
    if (!entry || params.runs.get(entry.runId) !== entry) {
      break;
    }
    visited.push(entry);
    requesterSessionKey = entry.requesterSessionKey;
    requesterAgentId = entry.requesterAgentId;
    const { runId } = entry;
    // A failed cleanup belongs to its retry timer or exhausted process-local
    // budget; even descendant settlement must not reopen that attempt early.
    if (
      typeof entry.execution.endedAt !== "number" ||
      entry.cleanupCompletedAt ||
      entry.cleanupHandled ||
      context.cleanupFailureCounts.has(getSubagentRunRuntimeKey(entry)) ||
      isDeliverySuspended(entry) ||
      params.suppressAnnounceForSteerRestart(entry)
    ) {
      continue;
    }
    const endedAgo = now - (entry.execution.endedAt ?? now);
    if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
      const attempt = beginSubagentCleanup(context, runId);
      if (!attempt) {
        continue;
      }
      const { cleanupGeneration, stateContext } = attempt;
      runDetachedCleanupAttempt(context, {
        runId,
        entry,
        cleanupGeneration,
        stateContext,
        run: () =>
          finalizeResumedAnnounceGiveUp(context, {
            entry,
            reason: "expiry",
            cleanupGeneration,
            stateContext,
          }),
      });
      continue;
    }
    params.resumedRuns.delete(getSubagentRunRuntimeKey(entry));
    params.resumeSubagentRun(runId);
  }
};

export const startSubagentAnnounceCleanupFlow = (
  context: SubagentLifecycleAnnounceCleanupContext,
  observedEntry: SubagentRunRecord,
): boolean => {
  const params = context.options;
  const publishedEntry = getCurrentSubagentRunOwner(params.runs, observedEntry);
  if (!publishedEntry) {
    return false;
  }
  let entry = publishedEntry;
  let runId = entry.runId;
  const runtimeKey = getSubagentRunRuntimeKey(observedEntry);
  if (entry.killReconciliation) {
    // Restores and unrelated cleanup retries must not publish a provisional
    // kill. The sweeper re-enters here after durable reconciliation.
    return false;
  }
  const cleanup = entry.cleanup;
  const skipRequesterDelivery = entry.suppressCompletionDelivery === true;
  // The spawning turn decides between individual review and a yielded batch.
  // Keep private results durable without admitting a competing requester turn.
  if (
    entry.completionTarget === "parent" &&
    entry.requesterTurnRunId &&
    !skipRequesterDelivery &&
    entry.delivery?.status !== "delivered"
  ) {
    return false;
  }
  // A terminal delivery failure closes upward delivery, not live descendants.
  // Their completion callback re-enters this same cleanup path without a timer.
  const checkDescendants = skipRequesterDelivery && entry.wakeOnDescendantSettle === true;
  let suppressSessionEffects = !context.sessionEffectsHostCurrent(entry);
  const attempt = beginSubagentCleanup(context, runId);
  if (!attempt) {
    return false;
  }
  const { cleanupGeneration, stateContext } = attempt;
  const assertPersistenceCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    assertSubagentRegistryWriteOutcomeKnown([current?.runId ?? runId], stateContext.admission);
  };
  const assertCurrent = () => {
    assertPersistenceCurrent();
    if (!context.isCleanupGenerationCurrent(entry, cleanupGeneration)) {
      throw new Error("Subagent cleanup generation changed before persistence.");
    }
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    if (current) {
      entry = current;
      runId = current.runId;
    }
  };
  const commit = async (
    mutate: (draft: SubagentRunRecord, current: SubagentRunRecord) => void | false,
    onPublished?: (published: SubagentRunRecord) => void,
  ) => {
    entry = await commitSubagentLifecycleMutation(context, {
      entry,
      stateContext,
      mutate,
      assertCurrent,
      onPublished,
    });
  };
  const alreadyDelivered = () =>
    typeof entry.delivery?.announcedAt === "number" || entry.delivery?.status === "delivered";
  const finalizeDelivered = (options?: { skipRequesterDelivery: boolean }) =>
    finalizeSubagentCleanup(context, entry, cleanup, "delivered", cleanupGeneration, stateContext, {
      skipAnnounce: true,
      ...options,
    });
  if (!checkDescendants && alreadyDelivered()) {
    runDetachedCleanupAttempt(context, {
      runId,
      entry,
      cleanupGeneration,
      stateContext,
      run: () => finalizeDelivered(),
    });
    return true;
  }
  const suppressChildSessionEffects = async () => {
    suppressSessionEffects = true;
    await commit((draft) => {
      if (draft.execution.suppressSessionEffects === true) {
        return false;
      }
      draft.execution.suppressSessionEffects = true;
      return undefined;
    });
  };
  const childSessionEffectsAllowed = () => {
    assertCurrent();
    if (!suppressSessionEffects && !context.sessionEffectsHostCurrent(entry)) {
      suppressSessionEffects = true;
    }
    return !suppressSessionEffects && context.isCleanupAttemptCurrent(entry, cleanupGeneration);
  };
  const prepareChildSessionEffects = async () => {
    assertCurrent();
    const suppress = !suppressSessionEffects && (await context.shouldSuppressSessionEffects(entry));
    assertPersistenceCurrent();
    if (!context.isCleanupAttemptCurrent(entry, cleanupGeneration)) {
      return false;
    }
    if (suppress || suppressSessionEffects) {
      await suppressChildSessionEffects();
    }
    return childSessionEffectsAllowed();
  };
  if (entry.expectsCompletionMessage === false || skipRequesterDelivery) {
    runDetachedCleanupAttempt(context, {
      runId,
      entry,
      cleanupGeneration,
      stateContext,
      run: async () => {
        // This driver is detached. Yield once so synchronous successor
        // registration can invalidate it before sessions.delete is submitted.
        await Promise.resolve();
        assertPersistenceCurrent();
        if (!context.isCleanupAttemptCurrent(entry, cleanupGeneration)) {
          await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
          return;
        }
        if (
          checkDescendants &&
          (await params.countPendingDescendantRuns(entry.childSessionKey, assertCurrent)) > 0
        ) {
          assertCurrent();
          await commit(
            (draft) => {
              draft.cleanupHandled = false;
            },
            () => params.resumedRuns.delete(runtimeKey),
          );
          if (
            (await params.countPendingDescendantRuns(entry.childSessionKey, assertCurrent)) === 0
          ) {
            assertCurrent();
            params.resumeSubagentRun(runId);
          }
          return;
        }
        if (checkDescendants && alreadyDelivered()) {
          await finalizeDelivered();
          return;
        }
        if (cleanup === "delete" && (await prepareChildSessionEffects())) {
          const cleanupSessionEntry = await loadSessionEntryByKey(entry.childSessionKey);
          const cleanupSessionIdentity =
            cleanupSessionEntry?.sessionId && cleanupSessionEntry.lifecycleRevision
              ? {
                  sessionId: cleanupSessionEntry.sessionId,
                  lifecycleRevision: cleanupSessionEntry.lifecycleRevision,
                }
              : undefined;
          const canDelete = await prepareChildSessionEffects();
          if (canDelete && !cleanupSessionIdentity) {
            // Without both lifecycle identities, key-only deletion could remove
            // a successor that reused this child session after cleanup yielded.
            await suppressChildSessionEffects();
          } else if (canDelete && cleanupSessionIdentity) {
            // This durable boundary prevents a late yield from reviving a run
            // after deletion may already have reached the gateway.
            await commit((draft) => {
              draft.deleteCleanupDispatchedAt ??= Date.now();
            });
            const sessionCleanup = await deleteSubagentSessionForCleanup({
              callGateway: params.callGateway,
              gatewayBinding: { resolveGatewayContext: getGatewayContextResolver(entry) },
              isCurrent: childSessionEffectsAllowed,
              prepareCurrent: prepareChildSessionEffects,
              childSessionKey: entry.childSessionKey,
              spawnMode: entry.spawnMode,
              expectedSessionId: cleanupSessionIdentity.sessionId,
              expectedLifecycleRevision: cleanupSessionIdentity.lifecycleRevision,
              onError: (error) =>
                params.warn("sessions.delete failed during subagent cleanup", {
                  error: buildSafeLifecycleErrorMeta(error),
                  runId: maskLifecycleIdentifier(runId, "run"),
                  childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
                }),
            });
            if (sessionCleanup === "failed") {
              throw new Error("subagent session cleanup did not complete");
            }
            if (sessionCleanup === "changed") {
              await suppressChildSessionEffects();
            }
          }
        }
        assertPersistenceCurrent();
        if (!context.isCleanupAttemptCurrent(entry, cleanupGeneration)) {
          await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
          return;
        }
        await finalizeDelivered({ skipRequesterDelivery });
      },
    });
    return true;
  }
  const pendingPayload = loadPendingFinalDeliveryPayload(entry);
  const requesterOrigin = normalizeDeliveryContext(pendingPayload.requesterOrigin);
  const requesterSettleGeneration = entry.requesterSettleWake?.rearmGeneration;
  const requesterOwnsCompletion = () => {
    assertCurrent();
    return entry.requesterTurnYielded === true || hasRequesterCompletionCohort(entry);
  };
  // Existing cohort ownership blocks competing sends but does not settle this attempt's delivery.
  const requesterTookCompletion = (current: SubagentRunRecord) =>
    current.requesterTurnYielded === true ||
    (current.completionTarget === "parent" &&
      current.requesterSettleWake?.requesterYieldBatch === true) ||
    current.requesterSettleWake?.rearmGeneration !== requesterSettleGeneration;
  let latestDeliveryError = getDeliveryLastError(entry);
  let committedDeliveryOwner: SubagentRunRecord | undefined;
  const finalizeAnnounceCleanup = async (announceOutcome: SubagentAnnounceFlowOutcome) => {
    assertPersistenceCurrent();
    if (!context.isCleanupAttemptCurrent(entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
      return;
    }
    assertCurrent();
    const mirrorResultText = entry.completion?.resultText;
    const mirrorStartedAt = entry.execution.startedAt;
    const deliveryMirrorAt =
      announceOutcome !== "delivered" && entry.delivery?.status !== "delivered"
        ? await hasPriorRequesterDeliveryMirror(params, entry)
        : undefined;
    assertPersistenceCurrent();
    if (!context.isCleanupAttemptCurrent(entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
      return;
    }
    // Requester-settle can commit delivery while the mirror lookup is pending.
    assertCurrent();
    let shouldCreditPriorDelivery = entry.delivery?.status === "delivered";
    if (deliveryMirrorAt !== undefined) {
      await commit((draft) => {
        shouldCreditPriorDelivery = draft.delivery?.status === "delivered";
        if (
          draft.completion?.resultText !== mirrorResultText ||
          draft.execution.startedAt !== mirrorStartedAt
        ) {
          return false;
        }
        ensureDeliveryState(draft).deliveredAt ??= deliveryMirrorAt;
        shouldCreditPriorDelivery = true;
        return undefined;
      });
    }
    const handedOff = requesterTookCompletion(entry);
    if (shouldCreditPriorDelivery || handedOff) {
      latestDeliveryError = undefined;
    }
    if (announceOutcome !== "delivered" && latestDeliveryError) {
      await commit((draft) => {
        if (draft.delivery?.status !== "delivered" && !requesterTookCompletion(draft)) {
          ensureDeliveryState(draft).lastError = latestDeliveryError;
        }
      });
    }
    await finalizeSubagentCleanup(
      context,
      entry,
      cleanup,
      shouldCreditPriorDelivery
        ? "delivered"
        : handedOff
          ? "intentional_non_delivery"
          : announceOutcome,
      cleanupGeneration,
      stateContext,
    );
  };

  const announceParams: Parameters<RunSubagentAnnounceFlow>[0] = {
    childSessionKey: pendingPayload.childSessionKey,
    childRunId: pendingPayload.childRunId,
    runTimeoutSeconds: entry.runTimeoutSeconds,
    requesterSessionKey: pendingPayload.requesterSessionKey,
    requesterAgentId: resolveSubagentRequesterAgentId(params.getRuntimeConfig(), entry),
    requesterOrigin,
    task: pendingPayload.task,
    timeoutMs: params.subagentAnnounceTimeoutMs,
    cleanup: suppressSessionEffects ? "keep" : cleanup,
    roundOneReply: entry.completion?.resultText ?? undefined,
    terminalReply: pendingPayload.terminalReply,
    fallbackReply: entry.completion?.fallbackResultText ?? undefined,
    startedAt: pendingPayload.startedAt,
    endedAt: pendingPayload.endedAt,
    label: pendingPayload.label,
    outcome: pendingPayload.outcome,
    spawnMode: pendingPayload.spawnMode,
    expectsCompletionMessage: pendingPayload.expectsCompletionMessage,
    completionTarget: pendingPayload.completionTarget,
    completionRequesterSessionId: pendingPayload.completionRequesterSessionId,
    completionRequesterLifecycleRevision: entry.completionRequesterLifecycleRevision,
    wakeOnDescendantSettle: pendingPayload.wakeOnDescendantSettle === true,
    suppressChildSessionEffects: suppressSessionEffects,
    isChildSessionEffectsAllowed: childSessionEffectsAllowed,
    prepareChildSessionEffects,
    isCompletionDeliveryAllowed: () => {
      assertPersistenceCurrent();
      return (
        isSubagentCompletionDeliveryAllowed(
          context,
          entry,
          cleanupGeneration,
          committedDeliveryOwner,
        ) && subagentRuns.runWithCompletionAuthority(entry, () => true)
      );
    },
    isCompletionOwnedByRequesterYield: requesterOwnsCompletion,
    onBeforeDeleteChildSession:
      cleanup === "delete"
        ? async () => {
            if (!childSessionEffectsAllowed()) {
              return false;
            }
            await commit((draft) => {
              if (
                draft.completion?.required === true &&
                draft.delivery?.status !== "delivered" &&
                draft.delivery?.status !== "failed" &&
                draft.delivery?.status !== "discarded" &&
                draft.delivery?.status !== "not_required"
              ) {
                const delivery = ensureDeliveryState(draft);
                delivery.createdAt ??= Date.now();
                delivery.payload = loadPendingFinalDeliveryPayload(draft);
              }
              draft.deleteCleanupDispatchedAt ??= Date.now();
            });
            return childSessionEffectsAllowed();
          }
        : undefined,
    onDeliveryResult: async (delivery) => {
      assertPersistenceCurrent();
      if (!context.isCleanupAttemptCurrent(entry, cleanupGeneration)) {
        retireSupersededCleanupInBackground(context, runId, entry, cleanupGeneration, stateContext);
        return;
      }
      assertCurrent();
      // A stale announce cannot replace a delivery already committed by requester-settle.
      if (entry.delivery?.status === "delivered") {
        return;
      }
      // A late failure cannot rearm an announcement transferred to the batch.
      // Committed sends still retain their delivery evidence.
      if (!delivery.delivered && requesterTookCompletion(entry)) {
        return;
      }
      if (
        !delivery.delivered &&
        delivery.reason === "message_tool_delivery_missing" &&
        delivery.disposition === "permanent_failure" &&
        shouldSuspendPendingFinalDelivery(entry)
      ) {
        latestDeliveryError = formatAnnounceDeliveryError(delivery);
        await suspendPendingFinalDelivery(context, {
          runId,
          entry,
          reason: "permanent_failure",
          error: latestDeliveryError,
          lastDropReason: delivery.reason,
          enqueuedAt: delivery.enqueuedAt,
        });
        return;
      }
      const requesterTurnPending =
        !delivery.delivered && delivery.reason === "requester_turn_pending";
      await commit(
        (draft, previous) => {
          if (
            draft.delivery?.status === "delivered" ||
            (!delivery.delivered && requesterTookCompletion(draft))
          ) {
            return false;
          }
          recordAnnounceDeliveryResult(draft, delivery, params.runs);
          const deliveryState = ensureDeliveryState(draft);
          latestDeliveryError =
            delivery.delivered || requesterTurnPending
              ? undefined
              : formatAnnounceDeliveryError(delivery);
          if (delivery.delivered) {
            deliveryState.status = "delivered";
            deliveryState.announcedAt = deliveryState.deliveredAt ?? Date.now();
            clearSubagentPendingDelivery(draft);
          } else if (!requesterTurnPending) {
            if (delivery.reason === "delivery_suppressed") {
              deliveryState.status = "failed";
            }
            deliveryState.lastError = latestDeliveryError;
          }
          if (
            requesterTurnPending ||
            (!delivery.delivered &&
              previous.delivery?.lastError === latestDeliveryError &&
              previous.delivery?.lastDropReason === deliveryState.lastDropReason &&
              previous.delivery?.disposition === deliveryState.disposition &&
              previous.delivery?.enqueuedAt === deliveryState.enqueuedAt &&
              previous.delivery?.status === deliveryState.status)
          ) {
            return false;
          }
          return undefined;
        },
        delivery.delivered
          ? (published) => {
              committedDeliveryOwner = published;
            }
          : undefined,
      );
    },
    // Idle completion has no ambient request scope. Missing entry ownership
    // fails closed instead of widening authority to another live Gateway.
    resolveGatewayContext: getGatewayContextResolver(entry),
  };
  runDetachedCleanupAttempt(context, {
    runId,
    entry,
    cleanupGeneration,
    stateContext,
    run: async () => {
      assertCurrent();
      let announceOutcome: SubagentAnnounceFlowOutcome = "retryable";
      const deadline = new AbortController();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const now = Date.now();
      const expiryMs =
        entry.expectsCompletionMessage === true
          ? ANNOUNCE_COMPLETION_HARD_EXPIRY_MS
          : ANNOUNCE_EXPIRY_MS;
      const remainingMs = resolveAnnounceDeliveryDeadline(entry, now, expiryMs) - now;
      const abortDelivery = () => deadline.abort(new Error("subagent announce delivery expired"));
      // Accepted handoffs can wait behind a busy parent without spending their
      // execution timeout, but the lifecycle's delivery window still bounds that wait.
      if (remainingMs <= 0) {
        abortDelivery();
      } else {
        deadlineTimer = setTimeout(abortDelivery, remainingMs);
        deadlineTimer.unref?.();
      }
      try {
        announceOutcome = await subagentRuns.runWithCompletionAuthority(entry, () =>
          params.runSubagentAnnounceFlow({
            ...announceParams,
            childAgentId: entry.childAgentId,
            signal: deadline.signal,
            // Delivery expiry bounds admission; the requester owns its execution budget.
            onExecutionStarted: () => clearTimeout(deadlineTimer),
          }),
        );
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        defaultRuntime.log(
          `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
        );
      } finally {
        clearTimeout(deadlineTimer);
      }
      assertPersistenceCurrent();
      if (
        context.isCleanupAttemptCurrent(entry, cleanupGeneration) &&
        getCurrentSubagentRunOwner(params.runs, entry)?.delivery?.status !== "delivered" &&
        (subagentRuns.isCompletionAuthorityRetired(entry) ||
          (shouldSuspendPendingFinalDelivery(entry) &&
            !isSystemEventStoreCurrent(
              entry.requesterSessionKey,
              entry.requesterStorePath,
              entry.requesterAgentId,
            )))
      ) {
        await suspendPendingFinalDelivery(context, {
          runId,
          entry,
          reason: "permanent_failure",
          error: "store replaced",
          storeReplaced: true,
        });
        return;
      }
      await finalizeAnnounceCleanup(announceOutcome);
    },
  });
  return true;
};
