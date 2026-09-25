import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
} from "../../../auto-reply/tokens.js";
import { logWarn } from "../../../logger.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../../runtime.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { createLazyPromise } from "../../../shared/lazy-promise.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import {
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../../internal-events.js";
import { isAnnounceSkip } from "../../tools/sessions-send-tokens.js";
import {
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
  SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION,
} from "../completion/subagent-completion-instructions.js";
import {
  countPendingDescendantRuns,
  getLatestSubagentRunByChildSessionKey,
  isSubagentSessionRunActive,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "../registry/subagent-registry-read.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
} from "./subagent-announce-delivery.js";
import { runDescendantWake } from "./subagent-announce-descendant-wake.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-origin.js";
import {
  applySubagentWaitOutcome,
  readChildCompletionFindings,
  readSubagentRunAnnounceResult,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  readSubagentTimeoutProgress,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callSubagentLifecycleGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  getRuntimeConfig,
  waitForEmbeddedAgentRunEnd,
} from "./subagent-announce.runtime.js";

const loadSubagentRegistryRuntime = createLazyPromise(
  () => import("../registry/subagent-registry-runtime.js"),
);

export { captureSubagentCompletionReply } from "./subagent-announce-output.js";

type SubagentAnnounceType = "subagent task" | "cron job";
export type SubagentAnnounceFlowOutcome =
  | NonNullable<SubagentAnnounceDeliveryResult["disposition"]>
  | "requester_turn_pending";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
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
    return SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION;
  }
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words.${modelRouteInstruction} Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}${modelRouteInstruction} Otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type). Reply ONLY: ${SILENT_REPLY_TOKEN} only when this exact result is already visible to the user in this same turn.`;
  }
  return `A completed ${params.announceType} is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}${modelRouteInstruction} Otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

export function hasUsableSessionEntry(entry: unknown): entry is Record<string, unknown> {
  if (!isRecord(entry)) {
    return false;
  }
  const sessionId = entry.sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
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

type SubagentAnnounceFlowParams = {
  childSessionKey: string;
  childRunId: string;
  runTimeoutSeconds?: number;
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
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
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  /** Deliver only frozen terminal facts; never inspect or mutate the child session. */
  suppressChildSessionEffects?: boolean;
  /** Live owner check for child-session effects after awaited phases. */
  isChildSessionEffectsAllowed?: () => boolean;
  /** Live owner check for requester delivery after awaited phases. */
  isCompletionDeliveryAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  onBeforeDeleteChildSession?: () => boolean;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
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
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  const childSessionEffectsAllowed = () =>
    params.suppressChildSessionEffects !== true &&
    params.isChildSessionEffectsAllowed?.() !== false;
  let isOwnResultCurrent = () => true;
  let isChildResultsCurrent = () => true;
  const completionDeliveryAllowed = () =>
    params.isCompletionDeliveryAllowed?.() !== false &&
    isOwnResultCurrent() &&
    isChildResultsCurrent();
  let childSessionId: string | undefined;
  let childSessionLifecycleRevision: string | undefined;
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterAgentId = params.requesterAgentId;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionEntry = !childSessionEffectsAllowed()
      ? undefined
      : loadSessionEntryByKey(params.childSessionKey);
    childSessionId =
      typeof childSessionEntry?.sessionId === "string" && childSessionEntry.sessionId.trim()
        ? childSessionEntry.sessionId.trim()
        : undefined;
    childSessionLifecycleRevision = normalizeOptionalString(childSessionEntry?.lifecycleRevision);
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply =
      params.terminalReply?.disposition === "visible"
        ? params.terminalReply.text
        : params.terminalReply?.disposition === "silent"
          ? SILENT_REPLY_TOKEN
          : params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedAgentRunActive(childSessionId)) {
      const settled = await waitForEmbeddedAgentRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedAgentRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
          return "retryable";
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
    if (failedTerminalOutcome && !params.terminalReply) {
      reply = undefined;
    }
    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey, {
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
        shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)
      ) {
        return "delivered";
      }

      const pendingChildDescendantRuns = !childSessionEffectsAllowed()
        ? 0
        : Math.max(0, countPendingDescendantRuns(params.childSessionKey));
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return "retryable";
      }

      if (childSessionEffectsAllowed() && params.wakeOnDescendantSettle === true) {
        const directChildren = listSubagentRunsForRequester(params.childSessionKey, {
          requesterRunId: params.childRunId,
        });
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          const completionRows = dedupeLatestChildCompletionRows(
            filterCurrentDirectChildCompletionRows(directChildren, {
              requesterSessionKey: params.childSessionKey,
              getLatestSubagentRunByChildSessionKey,
            }),
          );
          childCompletionRows = completionRows;
        }
      }
    } catch {
      // Best-effort only.
    }

    if (childCompletionRows) {
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
        isChildSessionEffectsAllowed: () =>
          childSessionEffectsAllowed() && completionDeliveryAllowed(),
        hasUsableSessionEntry,
        resolveGatewayContext: params.resolveGatewayContext,
        deps: {
          callGateway: callSubagentLifecycleGateway,
          dispatchGatewayMethodInProcess,
          getRuntimeConfig,
          replaceSubagentRunAfterSteer: subagentRegistryRuntime.replaceSubagentRunAfterSteer,
        },
        signal: params.signal,
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return "delivered";
      }
    }

    const fallbackReply = failedTerminalOutcome
      ? undefined
      : normalizeOptionalString(params.fallbackReply);
    const hasVisibleFallback =
      Boolean(fallbackReply) &&
      !(isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));
    const cleanedFallbackReply = hasVisibleFallback
      ? (stripAndClassifyReply(fallbackReply ?? "") ?? undefined)
      : undefined;

    const childRun = getLatestSubagentRunByChildSessionKey(params.childSessionKey);
    if (childSessionEffectsAllowed() && childRun?.runId === params.childRunId) {
      const prepared = await readSubagentRunAnnounceResult(childRun);
      reply = prepared.text;
      isOwnResultCurrent = prepared.isCurrent;
    }

    if (params.terminalReply?.disposition === "silent") {
      if (!hasVisibleFallback && (isAnnounceSkip(fallbackReply) || !expectsCompletionMessage)) {
        return "delivered";
      }
      reply = cleanedFallbackReply;
    }
    if (params.terminalReply?.disposition === "empty" && outcome.status === "timeout") {
      const timeoutProgress = await readSubagentTimeoutProgress(
        params.childSessionKey,
        params.timeoutMs,
        outcome,
      );
      // Empty remains the authoritative terminal fact. Transcript text is a
      // timeout-only progress hint and must never reclassify silence as output.
      if (timeoutProgress) {
        reply = stripAndClassifyReply(timeoutProgress) ?? undefined;
      }
    }
    if (!params.terminalReply) {
      if (childSessionEffectsAllowed() && !reply && allowFailedOutputCapture) {
        reply = await readSubagentOutput(params.childSessionKey, outcome);
      }

      if (childSessionEffectsAllowed() && !reply?.trim() && allowFailedOutputCapture) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          maxWaitMs: params.timeoutMs,
          outcome,
        });
      }

      if (!reply?.trim() && hasVisibleFallback) {
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

      const replyIsAnnounceSkip = isAnnounceSkip(reply);
      if (replyIsAnnounceSkip || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        if (hasVisibleFallback && cleanedFallbackReply) {
          reply = cleanedFallbackReply;
        } else {
          if (replyIsAnnounceSkip && isCronSessionKey(targetRequesterSessionKey)) {
            logWarn(
              `cron job completion for session=${targetRequesterSessionKey} ` +
                `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
                `the agent replied with the skip sentinel instead of delivering a result`,
            );
          }
          if (
            replyIsAnnounceSkip ||
            isAnnounceSkip(fallbackReply) ||
            !expectsCompletionMessage ||
            hasVisibleFallback
          ) {
            return "delivered";
          }
          reply = undefined;
        }
      } else if (reply) {
        reply = stripAndClassifyReply(reply) ?? cleanedFallbackReply;
        if (!reply) {
          return "delivered";
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    if (!childSessionEffectsAllowed()) {
      reply = params.roundOneReply ?? params.fallbackReply;
      if (
        expectsCompletionMessage &&
        (params.terminalReply?.disposition === "silent" ||
          isSilentReplyText(reply, SILENT_REPLY_TOKEN))
      ) {
        reply = hasVisibleFallback ? cleanedFallbackReply : undefined;
      }
      outcome = params.outcome ?? { status: "unknown" };
    }

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed; ready for parent review"
        : outcome.status === "timeout"
          ? outcome.error
            ? `timed out: ${outcome.error}`
            : "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionEffectsAllowed()
      ? childSessionId || "unknown"
      : "unknown";
    // Descendant findings are wake input; only this child's own answer travels onward.
    const childResultText = reply;
    const findings = childResultText || "(no output)";

    let requesterIsSubagent = requesterIsInternalSession();
    if (requesterIsSubagent) {
      if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
        if (
          params.completionTarget !== "parent" &&
          shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)
        ) {
          return "delivered";
        }
        const parentSessionEntry = loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive = hasUsableSessionEntry(parentSessionEntry);

        if (!parentSessionAlive) {
          if (params.completionTarget === "parent") {
            shouldDeleteChildSession = false;
            return "retryable";
          }
          const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
          if (!fallback?.requesterSessionKey) {
            shouldDeleteChildSession = false;
            return "retryable";
          }
          targetRequesterSessionKey = fallback.requesterSessionKey;
          targetRequesterAgentId = fallback.requesterAgentId;
          targetRequesterOrigin =
            normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey, {
            cfg: getRuntimeConfig(),
            agentId: targetRequesterAgentId,
          });
          requesterIsSubagent = requesterIsInternalSession();
        }
      }
    }

    const candidateStatsLine =
      params.completionTarget === "parent" || !childSessionEffectsAllowed()
        ? undefined
        : await buildCompactAnnounceStatsLine({
            sessionKey: params.childSessionKey,
            startedAt: params.startedAt,
            endedAt: params.endedAt,
          });
    const statsLine = childSessionEffectsAllowed() ? candidateStatsLine : undefined;
    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = loadRequesterSessionEntry(
        targetRequesterSessionKey,
        targetRequesterAgentId,
      );
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const candidateCompletionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent && params.completionTarget !== "parent"
        ? !childSessionEffectsAllowed()
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
    const completionDirectOrigin = childSessionEffectsAllowed()
      ? candidateCompletionDirectOrigin
      : targetRequesterOrigin;
    const completionChannel = normalizeMessageChannel(completionDirectOrigin?.channel);
    const modelRouteChange =
      params.terminalReply?.disposition === "visible"
        ? params.terminalReply.modelRouteChange
        : undefined;
    const replyInstruction = buildAnnounceReplyInstruction({
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
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
        source: announceType === "cron job" ? "cron" : "subagent",
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        announceType,
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
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    let deliveryResultReported = false;
    const reportDeliveryResult = async (delivery: SubagentAnnounceDeliveryResult) => {
      if (deliveryResultReported) {
        return;
      }
      deliveryResultReported = true;
      await params.onDeliveryResult?.(delivery);
    };
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      requesterAgentId: targetRequesterAgentId,
      triggerMessage,
      steerMessage: triggerMessage,
      internalEvents,
      requesterSessionOrigin: targetRequesterOrigin,
      completionDirectOrigin,
      directOrigin,
      sourceSessionKey: params.childSessionKey,
      sourceRunId: params.childRunId,
      sourceTool: "subagent_announce",
      isSourceSessionEffectsAllowed: completionDeliveryAllowed,
      isCompletionOwnedByRequesterYield: params.isCompletionOwnedByRequesterYield,
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage,
      completionTarget: params.completionTarget,
      completionRequesterSessionId: params.completionRequesterSessionId,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      onDeliveryResult: reportDeliveryResult,
      signal: params.signal,
      resolveGatewayContext: params.resolveGatewayContext,
    });
    await reportDeliveryResult(delivery);
    announceOutcome =
      delivery.reason === "requester_turn_pending"
        ? "requester_turn_pending"
        : (delivery.disposition ?? (delivery.delivered ? "delivered" : "retryable"));
  } catch (err) {
    shouldDeleteChildSession = false;
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // The spawn label is persisted at run start (agent request `label` →
    // buildAgentSessionPatch), so no post-run label patch is needed here.
    if (
      shouldDeleteChildSession &&
      childSessionEffectsAllowed() &&
      (params.onBeforeDeleteChildSession?.() ?? true)
    ) {
      await deleteSubagentSessionForCleanup({
        callGateway: callSubagentLifecycleGateway,
        isCurrent: childSessionEffectsAllowed,
        childSessionKey: params.childSessionKey,
        spawnMode: params.spawnMode,
        expectedSessionId: childSessionId,
        expectedLifecycleRevision: childSessionLifecycleRevision,
      });
    }
  }
  return announceOutcome;
}
