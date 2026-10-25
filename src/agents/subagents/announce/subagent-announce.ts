import { isSilentReplyText } from "../../../auto-reply/tokens.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { waitForSessionRunEnd } from "../../../sessions/session-controller.native-runtime.js";
import { isSessionRunActive } from "../../../sessions/session-controller.queries.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { createLazyPromise } from "../../../shared/lazy-promise.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import {
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../../internal-events.js";
import {
  buildSubagentPrivateCompletionInstruction,
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
} from "../completion/subagent-completion-instructions.js";
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
import type { PendingFinalDeliveryPayload } from "../registry/subagent-registry-read.types.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
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
  loadRequesterSessionEntry,
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
  type DeliveryContext,
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
import type { PreparedAnnounceResult } from "./subagent-announce-result.js";
import { describeChildrenEndedWithoutResult } from "./subagent-announce.requester-settle-message.js";
import { callSubagentLifecycleGateway, getRuntimeConfig } from "./subagent-announce.runtime.js";

const loadSubagentRegistryRuntime = createLazyPromise(
  () => import("../registry/subagent-registry.js"),
);

export { captureSubagentCompletionReply } from "./subagent-announce-output.js";

export type SubagentAnnounceFlowOutcome = NonNullable<
  SubagentAnnounceDeliveryResult["disposition"]
>;

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  requesterOrigin: DeliveryContext | undefined;
  completionTarget?: "parent";
  modelRouteChange?: string;
  preserveModelRouteNotice: boolean;
}): string {
  const modelRouteInstruction = !params.modelRouteChange
    ? ""
    : params.preserveModelRouteNotice
      ? " Preserve any runtime-authored model-route change notice in your update."
      : " Keep runtime-authored model-route change notices internal on this shared surface.";
  if (params.completionTarget === "parent") {
    return buildSubagentPrivateCompletionInstruction(params.requesterOrigin);
  }
  if (params.requesterIsSubagent) {
    return `${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} Convert the reviewed outcome into a concise internal orchestration update for your parent agent in your own words.${modelRouteInstruction} Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
  }
  return `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}${modelRouteInstruction} Otherwise send a truthful user-facing update unless this exact result is already visible to the user in this same turn. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim.`;
}

type SubagentAnnounceFlowParams = Omit<PendingFinalDeliveryPayload, "requesterDisplayKey"> & {
  childAgentId?: string;
  childSessionIdentity?: { sessionId: string; lifecycleRevision?: string };
  runTimeoutSeconds?: number;
  requesterAgentId?: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /** Cached pre-wake result for legacy runs without terminal facts. */
  fallbackReply?: string;
  completionRequesterLifecycleRevision?: string;
  /** Deliver only frozen terminal facts; never inspect or mutate the child session. */
  suppressChildSessionEffects?: boolean;
  /** Refresh database currency before child-session reads or effects. */
  prepareChildSessionEffects?: () => Promise<boolean>;
  /** Synchronous host-owner check immediately before child-session effects. */
  isChildSessionEffectsAllowed?: () => boolean;
  /** Live owner check for requester delivery after awaited phases. */
  isCompletionDeliveryAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  /** Exact source reserved synchronously by the durable registry handoff. */
  controllerInput?: SessionControllerInput;
  signal?: AbortSignal;
  onAccepted?: () => void;
  onExecutionStarted?: () => void;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  onBeforeDeleteChildSession?: () => boolean | Promise<boolean>;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
  /** A killed child produces no further output, so its notice never waits for one. */
  endedReason?: SubagentRunRecord["endedReason"];
};

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
  let deliveryResultReported = false;
  const reportDeliveryResult = async (delivery: SubagentAnnounceDeliveryResult) => {
    if (deliveryResultReported) {
      return;
    }
    deliveryResultReported = true;
    // A receipt observer may fail after handoff. Keep the transport outcome
    // authoritative so cleanup does not replay work the requester already consumed.
    announceOutcome = delivery.disposition ?? (delivery.delivered ? "delivered" : "retryable");
    await params.onDeliveryResult?.(delivery);
  };
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  let shouldDeleteChildSession = params.cleanup === "delete";
  const childSessionEffectsAllowed = () =>
    params.suppressChildSessionEffects !== true &&
    params.isChildSessionEffectsAllowed?.() !== false;
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
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
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

    let childCompletionFindings: string | undefined;
    let childCompletionRows: Parameters<typeof readChildCompletionFindings>[0] | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await loadSubagentRegistryRuntime();
      if (
        params.completionTarget !== "parent" &&
        requesterDepth >= 1 &&
        (await shouldIgnorePostCompletionAnnounceForSession(
          targetRequesterSessionKey,
          targetRequesterAgentId,
        ))
      ) {
        return "delivered";
      }

      const childSessionCurrent = await prepareChildSessionEffects();
      const pendingChildDescendantRuns =
        !childSessionCurrent || !childSessionEffectsAllowed()
          ? 0
          : Math.max(
              0,
              await countPendingDescendantRuns(params.childSessionKey, () => {
                if (!childSessionEffectsAllowed()) {
                  throw new Error("Subagent child-session effects are no longer current.");
                }
              }),
            );
      if (pendingChildDescendantRuns > 0) {
        shouldDeleteChildSession = false;
        return "retryable";
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
    if (!params.terminalReply && (!ownResult || !childRun?.completion?.terminalReply)) {
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
        return "delivered";
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

    const taskLabel = params.label || params.task || "task";
    const statusLabel = killed
      ? describeChildrenEndedWithoutResult([taskLabel])
      : outcome.status === "ok"
        ? "completed; ready for parent review"
        : outcome.status === "timeout"
          ? outcome.error
            ? `timed out: ${outcome.error}`
            : "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    const announceSessionId =
      childSessionCurrent && childSessionEffectsAllowed() ? childSessionId || "unknown" : "unknown";
    // Descendant findings are wake input; only this child's own answer travels onward.
    const childResultText = reply;
    const findings = childResultText || "(no output)";

    let requesterIsSubagent = requesterIsInternalSession();
    if (requesterIsSubagent) {
      if (!isSubagentSessionRunActive(targetRequesterSessionKey, targetRequesterAgentId)) {
        if (
          params.completionTarget !== "parent" &&
          (await shouldIgnorePostCompletionAnnounceForSession(
            targetRequesterSessionKey,
            targetRequesterAgentId,
          ))
        ) {
          return "delivered";
        }
        const parentSessionEntry = await loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive = hasUsableSessionEntry(parentSessionEntry);

        if (!parentSessionAlive) {
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
          requesterIsSubagent = requesterIsInternalSession();
        }
      }
    }

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
    await withSubagentRequesterSource(
      targetRequesterSessionKey,
      targetRequesterAgentId,
      async (isRequesterCurrent) => {
        // Send to the requester session. For nested subagents this is an internal
        // follow-up injection (deliver=false) so the orchestrator receives it.
        let directOrigin = targetRequesterOrigin;
        if (!requesterIsSubagent) {
          const { entry } = await loadRequesterSessionEntry(
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
        const replyInstruction = buildAnnounceReplyInstruction({
          requesterIsSubagent,
          requesterOrigin: directOrigin,
          completionTarget: params.completionTarget,
          modelRouteChange,
          // Nested and local operator parents may report the route fact. External
          // channel parents receive it only as private orchestration context.
          preserveModelRouteNotice:
            requesterIsSubagent ||
            !completionChannel ||
            !isDeliverableMessageChannel(completionChannel),
        });
        const internalEvents: AgentInternalEvent[] = [
          {
            type: "task_completion",
            source: "subagent",
            announceType: "subagent task",
            childSessionKey: params.childSessionKey,
            childSessionId: announceSessionId,
            taskLabel,
            status: outcome.status,
            statusLabel,
            result: findings,
            ...(childResultText ? {} : { noVisibleResult: true }),
            modelRouteChange,
            statsLine,
            replyInstruction,
          },
        ];
        const triggerMessage =
          formatAgentInternalEventsForPrompt(internalEvents) ||
          "A background task finished. Process the completion update now.";
        const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
        const delivery = await deliverSubagentAnnouncement({
          requesterSessionKey: targetRequesterSessionKey,
          requesterAgentId: targetRequesterAgentId,
          triggerMessage,
          internalEvents,
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
          completionRequesterSessionId: params.completionRequesterSessionId,
          completionRequesterLifecycleRevision: params.completionRequesterLifecycleRevision,
          directIdempotencyKey,
          onDeliveryResult: reportDeliveryResult,
          signal: params.signal,
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
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
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
