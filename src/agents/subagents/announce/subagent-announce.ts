import { isSilentReplyText } from "../../../auto-reply/tokens.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { defaultRuntime } from "../../../runtime.js";
import { retireSessionControllerInput } from "../../../sessions/session-controller.mailbox.js";
import { waitForSessionRunEnd } from "../../../sessions/session-controller.native-runtime.js";
import { isSessionRunActive } from "../../../sessions/session-controller.queries.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { createLazyPromise } from "../../../shared/lazy-promise.js";
import { subagentCompletionForOutcome } from "../../../shared/subagent-completion.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { buildSubagentAnnounceMessages } from "../../subagent-announce-message.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  countPendingDescendantRuns,
  buildLatestSubagentSessionListReadIndex,
  isSubagentSessionRunActive,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "../registry/subagent-registry-read.js";
import { getSubagentTerminalReplySummary } from "../registry/subagent-run-payload-facts.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { getSubagentDepthFromSessionStoreInWorker } from "../spawn/subagent-depth.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import {
  hasAnnounceSendEvidence,
  isPermanentAnnounceDeliveryError,
  SourceOwnerChangedError,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  deliverSubagentAnnouncement,
  loadSessionEntryByKey,
} from "./subagent-announce-delivery.js";
import {
  hasUsableSessionEntry,
  withSubagentRequesterSource,
} from "./subagent-announce-delivery.runtime.js";
import { runDescendantWake } from "./subagent-announce-descendant-wake.js";
import {
  sourceOwnerChangedResult,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-origin.js";
import {
  readChildCompletionFindings,
  readSubagentRunAnnounceResult,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  readSubagentTimeoutProgress,
} from "./subagent-announce-output.js";
import {
  createOwnerBoundContinuationEntryLoader,
  createSubagentAnnounceEntryReaders,
  formatSubagentAnnounceOwnerFailure,
} from "./subagent-announce-owner-coordination.js";
import type { PreparedAnnounceResult } from "./subagent-announce-result.js";
import {
  callSubagentLifecycleGateway,
  getRuntimeConfig,
  resolveContinuationRuntimeConfig,
} from "./subagent-announce.runtime.js";
import type {
  SubagentAnnounceFlowOutcome,
  SubagentAnnounceFlowParams,
} from "./subagent-announce.types.js";

const loadSubagentRegistryRuntime = createLazyPromise(
  () => import("../registry/subagent-registry.js"),
);
const loadSubagentContinuationRuntime = createLazyPromise(
  () => import("../../subagent-announce.continuation.runtime.js"),
);

export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type {
  SubagentAnnounceFlowOutcome,
  SubagentAnnounceFlowParams,
} from "./subagent-announce.types.js";

export async function runSubagentAnnounceFlow(
  params: SubagentAnnounceFlowParams,
): Promise<SubagentAnnounceFlowOutcome> {
  return await (params.resolveGatewayContext
    ? withPluginRuntimeGatewayContextResolver(params.resolveGatewayContext, () =>
        runSubagentAnnounceFlowBound(params),
      )
    : runSubagentAnnounceFlowBound(params));
}

async function runSubagentAnnounceFlowBound(
  params: SubagentAnnounceFlowParams,
): Promise<SubagentAnnounceFlowOutcome> {
  let announceOutcome: SubagentAnnounceFlowOutcome = "retryable";
  let failureStage = "session-owner-resolution";
  let deliveryResultReported = false;
  const reportDeliveryResult = async (delivery: SubagentAnnounceDeliveryResult) => {
    if (deliveryResultReported) {
      return;
    }
    deliveryResultReported = true;
    // A receipt observer may fail after handoff. Keep the transport outcome
    // authoritative so cleanup does not replay work the requester already consumed.
    announceOutcome =
      delivery.reason === "completion_handoff_pending" && delivery.terminal
        ? "requester_waiting"
        : (delivery.disposition ?? (delivery.delivered ? "delivered" : "retryable"));
    await params.onDeliveryResult?.(delivery);
  };
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  let shouldDeleteChildSession = params.cleanup === "delete";
  const childSessionEffectsAllowed = () =>
    params.suppressChildSessionEffects !== true &&
    params.isChildSessionEffectsAllowed?.() !== false;
  // Upstream result-currency gating: a result that changed mid-announce must
  // not be delivered. Both closures are replaced by prepared reads below.
  const prepareChildSessionEffects = async () =>
    childSessionEffectsAllowed() &&
    (await params.prepareChildSessionEffects?.()) !== false &&
    childSessionEffectsAllowed();
  let ownResult: PreparedAnnounceResult | undefined;
  let isChildResultsCurrent = () => true;
  const completionDeliveryAllowed = () =>
    params.isCompletionDeliveryAllowed?.() !== false &&
    (ownResult?.isCurrent() ?? true) &&
    isChildResultsCurrent();
  let childSessionId: string | undefined;
  try {
    const { invalidateSessionEntry, readRequesterSessionEntry, readSessionEntryByKey } =
      createSubagentAnnounceEntryReaders();
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterAgentId = params.requesterAgentId;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionEntry =
      !(await prepareChildSessionEffects()) || !childSessionEffectsAllowed()
        ? undefined
        : await loadSessionEntryByKey(
            params.childSessionKey,
            parseAgentSessionKey(params.childSessionKey) ? undefined : params.childAgentId,
          );
    childSessionId =
      typeof childSessionEntry?.sessionId === "string" && childSessionEntry.sessionId.trim()
        ? childSessionEntry.sessionId.trim()
        : undefined;
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    const legacySilent = !params.terminalReply && isSilentReplyText(params.roundOneReply);
    let reply =
      params.terminalReply?.disposition === "visible"
        ? params.terminalReply.text
        : params.terminalReply || legacySilent
          ? undefined
          : params.roundOneReply;
    const outcome: SubagentRunOutcome = params.outcome ?? { status: "unknown" };
    if (
      childSessionId &&
      (await prepareChildSessionEffects()) &&
      childSessionEffectsAllowed() &&
      isSessionRunActive(childSessionId)
    ) {
      const settled = await waitForSessionRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isSessionRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome.status !== "timeout" || params.cleanup === "delete") {
          return "retryable";
        }
      }
    }
    const failedTerminalOutcome = outcome.status === "error";
    const killed = params.endedReason === SUBAGENT_ENDED_REASON_KILLED;
    const allowFailedOutputCapture =
      !killed && (!failedTerminalOutcome || (!params.roundOneReply && !params.fallbackReply));
    if (failedTerminalOutcome && !params.terminalReply) {
      reply = undefined;
    }

    let requesterDepth = await getSubagentDepthFromSessionStoreInWorker(targetRequesterSessionKey, {
      cfg: getRuntimeConfig(),
      agentId: targetRequesterAgentId,
    });
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);
    // Keep this aligned with the targeted-return router. Any explicit target,
    // plural target set, or fanout mode must reach that router even if the
    // immediate requester has already been cleaned up.
    const hasTargeting = Boolean(
      params.continuationTargetSessionKey ||
      (params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0) ||
      params.continuationFanoutMode,
    );

    let childCompletionFindings: string | undefined;
    let childCompletionRows: Parameters<typeof readChildCompletionFindings>[0] | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await loadSubagentRegistryRuntime();
      if (requesterIsInternalSession()) {
        if (!isSubagentSessionRunActive(targetRequesterSessionKey, targetRequesterAgentId)) {
          // A cleaned-up intermediate child normally must not receive a late
          // ordinary completion announcement. A tree continuation return is
          // different: its ancestor set is resolved from that intermediate
          // child, so dropping here strands a completed grandchild before the
          // targeted-return router can deliver to the root.
          if (
            params.completionTarget !== "parent" &&
            !hasTargeting &&
            (await shouldIgnorePostCompletionAnnounceForSession(
              targetRequesterSessionKey,
              targetRequesterAgentId,
            ))
          ) {
            return "delivered";
          }
          if (!hasUsableSessionEntry(await readSessionEntryByKey(targetRequesterSessionKey))) {
            if (params.completionTarget === "parent") {
              shouldDeleteChildSession = false;
              return "retryable";
            }
            const fallback = await resolveRequesterForChildSession(
              targetRequesterSessionKey,
              targetRequesterAgentId,
            );
            if (!fallback?.requesterSessionKey) {
              shouldDeleteChildSession = false;
              return "retryable";
            }
            targetRequesterSessionKey = fallback.requesterSessionKey;
            targetRequesterAgentId = fallback.requesterAgentId;
            targetRequesterOrigin =
              normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
            requesterDepth = await getSubagentDepthFromSessionStoreInWorker(
              targetRequesterSessionKey,
              {
                cfg: getRuntimeConfig(),
                agentId: targetRequesterAgentId,
              },
            );
          }
        }
      }

      const childSessionCurrent = await prepareChildSessionEffects();
      const assertChildSessionCurrent = () => {
        if (!childSessionEffectsAllowed()) {
          throw new Error("Subagent child-session effects are no longer current.");
        }
      };
      const pendingChildDescendantRuns =
        !childSessionCurrent || !childSessionEffectsAllowed()
          ? 0
          : await countPendingDescendantRuns(params.childSessionKey, assertChildSessionCurrent);
      if (pendingChildDescendantRuns > 0) {
        // Suspended descendants keep the child session for recovery but cannot hold this completion.
        shouldDeleteChildSession = false;
        const unsettledDescendantRuns = await countPendingDescendantRuns(
          params.childSessionKey,
          assertChildSessionCurrent,
          { excludeSuspendedDelivery: true },
        );
        if (unsettledDescendantRuns > 0) {
          return "retryable";
        }
      }

      if (
        childSessionCurrent &&
        childSessionEffectsAllowed() &&
        params.wakeOnDescendantSettle === true
      ) {
        const directChildren = listSubagentRunsForRequester(params.childSessionKey, {
          requesterRunId: params.childRunId,
        });
        if (directChildren.length > 0) {
          childCompletionRows = dedupeLatestChildCompletionRows(
            filterCurrentDirectChildCompletionRows(directChildren, {
              requesterSessionKey: params.childSessionKey,
              getLatestSubagentRunByChildSessionKey: buildLatestSubagentSessionListReadIndex(
                directChildren.map((entry) => entry.childSessionKey),
              ).getLatestSubagentRun,
            }),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    if (
      childCompletionRows &&
      (await prepareChildSessionEffects()) &&
      childSessionEffectsAllowed()
    ) {
      const prepared = await readChildCompletionFindings(childCompletionRows);
      childCompletionFindings = prepared.text;
      isChildResultsCurrent = prepared.isCurrent;
    }

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });

    if (
      params.wakeOnDescendantSettle === true &&
      childCompletionFindings?.trim() &&
      subagentRegistryRuntime
    ) {
      const woke = await runDescendantWake({
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        runTimeoutSeconds: params.runTimeoutSeconds,
        taskLabel: params.label || params.task || "task",
        findings: childCompletionFindings,
        announceId,
        prepareCurrent: prepareChildSessionEffects,
        isChildSessionEffectsAllowed: () =>
          childSessionEffectsAllowed() && completionDeliveryAllowed(),
        resolveGatewayContext: params.resolveGatewayContext,
        replaceSubagentRunAfterSteer: subagentRegistryRuntime.replaceSubagentRunAfterSteerCore,
        signal: params.signal,
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return "delivered";
      }
    }

    let skipAnnounceDelivery = false;
    const fallbackReply =
      params.terminalReply || failedTerminalOutcome ? undefined : params.fallbackReply?.trim();
    const visibleFallback =
      fallbackReply && !isSilentReplyText(fallbackReply) ? fallbackReply : undefined;

    const childRun = subagentRuns.get(params.childRunId);
    if (childRun?.childSessionKey === params.childSessionKey && completionDeliveryAllowed()) {
      ownResult = await readSubagentRunAnnounceResult(childRun);
      reply = ownResult.text;
    }

    if (params.terminalReply?.disposition === "silent") {
      if (!expectsCompletionMessage) {
        return "delivered";
      }
      reply = undefined;
    }
    if (
      params.terminalReply?.disposition === "empty" &&
      outcome.status === "timeout" &&
      (await prepareChildSessionEffects()) &&
      childSessionEffectsAllowed()
    ) {
      const timeoutProgress = await readSubagentTimeoutProgress(
        params.childSessionKey,
        params.timeoutMs,
        outcome,
        params.childAgentId,
      );
      // Empty remains the authoritative terminal fact. Transcript text is a
      // timeout-only progress hint and must never reclassify silence as output.
      if (timeoutProgress) {
        reply = timeoutProgress;
      }
    }
    if (
      !params.terminalReply &&
      (!ownResult || !childRun || !getSubagentTerminalReplySummary(childRun))
    ) {
      if (
        !legacySilent &&
        !reply &&
        allowFailedOutputCapture &&
        (await prepareChildSessionEffects()) &&
        childSessionEffectsAllowed()
      ) {
        reply = await readSubagentOutput(params.childSessionKey, outcome, {
          childAgentId: params.childAgentId,
        });
      }
      if (
        !legacySilent &&
        !reply?.trim() &&
        allowFailedOutputCapture &&
        (await prepareChildSessionEffects()) &&
        childSessionEffectsAllowed()
      ) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          childAgentId: params.childAgentId,
          maxWaitMs: params.timeoutMs,
          outcome,
        });
      }
      if (!reply?.trim() && visibleFallback) {
        reply = visibleFallback;
      }
      if (legacySilent && !reply?.trim() && !expectsCompletionMessage) {
        // Continuation coordination still runs for a silent child; it decides
        // whether the suppressed completion is delivered at all.
        skipAnnounceDelivery = true;
      }
    }

    const childSessionCurrent = await prepareChildSessionEffects();
    if (!ownResult && (!childSessionCurrent || !childSessionEffectsAllowed())) {
      reply =
        params.terminalReply?.disposition === "visible"
          ? (params.roundOneReply ?? params.terminalReply.text)
          : params.terminalReply
            ? undefined
            : legacySilent
              ? visibleFallback
              : (params.roundOneReply ?? visibleFallback);
    }

    const cfg = getRuntimeConfig();
    const announceSessionId =
      childSessionCurrent && childSessionEffectsAllowed() ? childSessionId || "unknown" : "unknown";

    const taskLabel = params.label || params.task || "task";
    // Descendant findings are wake input; only this child's own answer travels
    // onward, so private descendants can never leak through the parent result.
    const childResultText = reply;
    let findings = childResultText || "(no output)";
    const continuationRuntime = await loadSubagentContinuationRuntime();
    failureStage = "terminal-token-admission";
    const continuation = await continuationRuntime.coordinateSubagentContinuation({
      cfg,
      childSessionKey: params.childSessionKey,
      childAgentId: params.childAgentId,
      childRunId: params.childRunId,
      targetRequesterSessionKey,
      targetRequesterOrigin,
      task: params.task ?? "",
      findings,
      ...(ownResult?.continuationParts && childResultText === ownResult.text
        ? { continuationParts: ownResult.continuationParts }
        : {}),
      skipAnnounceDelivery,
      silentAnnounce: params.silentAnnounce,
      wakeOnReturn: params.wakeOnReturn,
      traceparent: params.traceparent,
      loadEntry: createOwnerBoundContinuationEntryLoader({
        childSessionKey: params.childSessionKey,
        childAgentId: params.childAgentId,
        requesterSessionKey: targetRequesterSessionKey,
        requesterAgentId: targetRequesterAgentId,
        loadOwned: loadSessionEntryByKey,
        loadFallback: readSessionEntryByKey,
      }),
      invalidateSessionEntry,
    });
    findings = continuation.findings;
    if (
      continuation.originDelegateFlowStatus === "queued" ||
      continuation.originDelegateFlowStatus === "running" ||
      ((await prepareChildSessionEffects()) &&
        childSessionEffectsAllowed() &&
        (await countPendingDescendantRuns(params.childSessionKey, () => {
          if (!childSessionEffectsAllowed()) {
            throw new Error("Subagent child-session effects are no longer current.");
          }
        })) > 0)
    ) {
      // Coordination can admit a child after the earlier descendant check.
      // Recheck now so cleanup cannot retire the orchestrator before its return.
      shouldDeleteChildSession = false;
      return "retryable";
    }
    if (continuation.skipAnnounceDelivery) {
      return "delivered";
    }
    const requesterIsSubagent = requesterIsInternalSession();
    await withSubagentRequesterSource(
      targetRequesterSessionKey,
      targetRequesterAgentId,
      async (isRequesterCurrent) => {
        let directOrigin = targetRequesterOrigin;
        if (!requesterIsSubagent) {
          const { entry } = await readRequesterSessionEntry(
            targetRequesterSessionKey,
            targetRequesterAgentId,
          );
          directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
        }
        const candidateCompletionDirectOrigin =
          expectsCompletionMessage && !requesterIsSubagent && params.completionTarget !== "parent"
            ? !(await prepareChildSessionEffects()) || !childSessionEffectsAllowed()
              ? targetRequesterOrigin
              : await resolveSubagentCompletionOrigin({
                  childSessionKey: params.childSessionKey,
                  requesterSessionKey: targetRequesterSessionKey,
                  requesterOrigin: directOrigin,
                  childRunId: params.childRunId,
                  spawnMode: params.spawnMode,
                  expectsCompletionMessage,
                })
            : targetRequesterOrigin;
        const completionDirectOrigin =
          (await prepareChildSessionEffects()) && childSessionEffectsAllowed()
            ? candidateCompletionDirectOrigin
            : targetRequesterOrigin;
        const completionChannel = normalizeMessageChannel(completionDirectOrigin?.channel);
        const modelRouteChange =
          params.terminalReply?.disposition === "visible"
            ? params.terminalReply.modelRouteChange
            : undefined;
        const preserveModelRouteNotice =
          requesterIsSubagent ||
          !completionChannel ||
          !isDeliverableMessageChannel(completionChannel);

        const candidateStatsLine =
          params.completionTarget === "parent" ||
          !(await prepareChildSessionEffects()) ||
          !childSessionEffectsAllowed()
            ? undefined
            : await buildCompactAnnounceStatsLine({
                sessionKey: params.childSessionKey,
                childAgentId: params.childAgentId,
                startedAt: params.startedAt,
                endedAt: params.endedAt,
              });
        const statsLine =
          (await prepareChildSessionEffects()) && childSessionEffectsAllowed()
            ? candidateStatsLine
            : undefined;
        const { internalEvents, triggerMessage } = buildSubagentAnnounceMessages({
          requesterIsSubagent,
          requesterOrigin: directOrigin,
          completionTarget: params.completionTarget,
          childSessionKey: params.childSessionKey,
          childSessionId: announceSessionId,
          taskLabel,
          outcome,
          killed,
          findings,
          noVisibleResult: !childResultText && findings === "(no output)",
          statsLine,
          modelRouteChange,
          preserveModelRouteNotice,
        });
        failureStage = "return-routing";
        const returnRoute = await continuationRuntime.routeSubagentContinuationReturn({
          cfg,
          continuationEnabled: continuation.continuationEnabled,
          isContinuationChainDelegate: continuation.isContinuationChainDelegate,
          maxChainLength: resolveContinuationRuntimeConfig(cfg).maxChainLength,
          task: params.task ?? "",
          taskLabel,
          triggerMessage,
          announceId,
          childSessionKey: params.childSessionKey,
          childAgentId: continuation.ownerAgentId,
          childRunId: params.childRunId,
          targetRequesterSessionKey,
          targetRequesterAgentId,
          silentAnnounce: params.silentAnnounce,
          wakeOnReturn: params.wakeOnReturn,
          continuationTargetSessionKey: params.continuationTargetSessionKey,
          continuationTargetSessionKeys: params.continuationTargetSessionKeys,
          continuationFanoutMode: params.continuationFanoutMode,
          continuationRecipientAuthorityBinding: params.continuationRecipientAuthorityBinding,
          persistContinuationRecipientAuthorityBinding:
            params.persistContinuationRecipientAuthorityBinding,
          traceparent: params.traceparent,
          // Resolve the reads lazily: building this object eagerly would touch the
          // read-module namespace on every announce, including flows that never
          // reach the continuation-return router.
          registryRuntime: {
            shouldIgnorePostCompletionAnnounceForSession: (sessionKey: string) =>
              shouldIgnorePostCompletionAnnounceForSession(sessionKey),
          },
        });
        if (returnRoute.handled) {
          announceOutcome = "delivered";
          return;
        }

        failureStage = "completion-delivery";
        // Send to the requester session. For nested subagents this is an internal
        // follow-up injection (deliver=false) so the orchestrator receives it.
        const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
        const delivery = await deliverSubagentAnnouncement({
          requesterSessionKey: targetRequesterSessionKey,
          requesterAgentId: targetRequesterAgentId,
          triggerMessage,
          internalEvents,
          subagentCompletions: [
            subagentCompletionForOutcome(
              { runId: params.childRunId, sessionKey: params.childSessionKey, label: params.label },
              outcome.status,
              killed,
            ),
          ].filter((completion) => completion !== undefined),
          requesterSessionOrigin: targetRequesterOrigin,
          completionDirectOrigin,
          directOrigin,
          sourceSessionKey: params.childSessionKey,
          sourceRunId: params.childRunId,
          sourceTool: "subagent_announce",
          isSourceSessionEffectsAllowed: () =>
            isRequesterCurrent?.() !== false && completionDeliveryAllowed(),
          isCompletionOwnedByRequesterYield: params.isCompletionOwnedByRequesterYield,
          targetRequesterSessionKey,
          requesterIsSubagent,
          expectsCompletionMessage,
          completionTarget: params.completionTarget,
          directIdempotencyKey,
          onDeliveryResult: reportDeliveryResult,
          signal: params.signal,
          continuationTriggerOverride: returnRoute.continuationTriggerOverride,
          ...(returnRoute.traceparent ? { traceparent: returnRoute.traceparent } : {}),
          onAccepted: params.onAccepted,
          onExecutionStarted: params.onExecutionStarted,
          resolveGatewayContext: params.resolveGatewayContext,
          controllerInput: params.controllerInput,
        });
        await reportDeliveryResult(delivery);
      },
      () => params.controllerInput,
    );
  } catch (err) {
    shouldDeleteChildSession = false;
    if (hasSqliteWorkerOutcomeUnknown(err)) {
      throw err;
    }
    defaultRuntime.error(
      formatSubagentAnnounceOwnerFailure({
        childSessionKey: params.childSessionKey,
        childAgentId: params.childAgentId,
        requesterAgentId: params.requesterAgentId,
        failureStage,
        error: err,
      }),
    );
    if (!deliveryResultReported) {
      await reportDeliveryResult(
        err instanceof SourceOwnerChangedError
          ? sourceOwnerChangedResult()
          : {
              delivered: false,
              path: "none",
              error: summarizeDeliveryError(err),
              disposition:
                hasAnnounceSendEvidence(err) || isPermanentAnnounceDeliveryError(err)
                  ? "permanent_failure"
                  : "retryable",
            },
      );
    }
  } finally {
    if (params.controllerInput && !params.controllerInput.custody.rpcAdopted) {
      retireSessionControllerInput(params.controllerInput);
    }
    if (
      shouldDeleteChildSession &&
      (await prepareChildSessionEffects()) &&
      childSessionEffectsAllowed() &&
      ((await params.onBeforeDeleteChildSession?.()) ?? true) &&
      childSessionEffectsAllowed()
    ) {
      await deleteSubagentSessionForCleanup({
        callGateway: callSubagentLifecycleGateway,
        gatewayBinding: { resolveGatewayContext: params.resolveGatewayContext },
        prepareCurrent: prepareChildSessionEffects,
        isCurrent: childSessionEffectsAllowed,
        childSessionKey: params.childSessionKey,
        childAgentId: params.childAgentId,
        spawnMode: params.spawnMode,
        expectedSessionId: params.childSessionIdentity?.sessionId,
        expectedLifecycleRevision: params.childSessionIdentity?.lifecycleRevision,
      });
    }
  }
  return announceOutcome;
}
