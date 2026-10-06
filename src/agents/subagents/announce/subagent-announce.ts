import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../../../auto-reply/tokens.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
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
import {
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
  SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION,
} from "../completion/subagent-completion-instructions.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  countPendingDescendantRuns,
  buildLatestSubagentSessionListReadIndex,
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
import {
  callSubagentLifecycleGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  getRuntimeConfig,
  waitForEmbeddedAgentRunEnd,
} from "./subagent-announce.runtime.js";

const loadSubagentRegistryRuntime = createLazyPromise(
  () => import("../registry/subagent-registry.js"),
);

export { captureSubagentCompletionReply } from "./subagent-announce-output.js";

export type SubagentAnnounceFlowOutcome =
  | NonNullable<SubagentAnnounceDeliveryResult["disposition"]>
  | "requester_turn_pending";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
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
    return `${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} Convert the reviewed outcome into a concise internal orchestration update for your parent agent in your own words.${modelRouteInstruction} Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
  }
  return `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}${modelRouteInstruction} Otherwise send a truthful user-facing update unless this exact result is already visible to the user in this same turn. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim.`;
}

export function hasUsableSessionEntry(entry: unknown): entry is Record<string, unknown> {
  if (!isRecord(entry)) {
    return false;
  }
  const sessionId = entry.sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

function stripAndClassifyReply(text: string): string | null {
  const hasLeadingSilentToken = startsWithSilentToken(text, SILENT_REPLY_TOKEN);
  if (!hasLeadingSilentToken && !text.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    return text;
  }
  const result = stripSilentToken(
    hasLeadingSilentToken ? stripLeadingSilentToken(text, SILENT_REPLY_TOKEN) : text,
    SILENT_REPLY_TOKEN,
  );
  return !result || isSilentReplyText(result, SILENT_REPLY_TOKEN) ? null : result;
}

type SubagentAnnounceFlowParams = {
  childSessionKey: string;
  childAgentId?: string;
  childRunId: string;
  runTimeoutSeconds?: number;
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
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
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  completionRequesterLifecycleRevision?: string;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  /** Deliver only frozen terminal facts; never inspect or mutate the child session. */
  suppressChildSessionEffects?: boolean;
  /** Refresh database currency before child-session reads or effects. */
  prepareChildSessionEffects?: () => Promise<boolean>;
  /** Synchronous host-owner check immediately before child-session effects. */
  isChildSessionEffectsAllowed?: () => boolean;
  /** Live owner check for requester delivery after awaited phases. */
  isCompletionDeliveryAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  signal?: AbortSignal;
  onExecutionStarted?: () => void;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  onBeforeDeleteChildSession?: () => boolean | Promise<boolean>;
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
  let childSessionLifecycleRevision: string | undefined;
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterAgentId = params.requesterAgentId;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionEntry =
      !(await prepareChildSessionEffects()) || !childSessionEffectsAllowed()
        ? undefined
        : await loadSessionEntryByKey(params.childSessionKey);
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
    const outcome: SubagentRunOutcome = params.outcome ?? { status: "unknown" };
    if (
      childSessionId &&
      (await prepareChildSessionEffects()) &&
      childSessionEffectsAllowed() &&
      isEmbeddedAgentRunActive(childSessionId)
    ) {
      const settled = await waitForEmbeddedAgentRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedAgentRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
          return "retryable";
        }
      }
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
        hasUsableSessionEntry,
        resolveGatewayContext: params.resolveGatewayContext,
        deps: {
          callGateway: callSubagentLifecycleGateway,
          dispatchGatewayMethodInProcess,
          getRuntimeConfig,
          replaceSubagentRunAfterSteer: subagentRegistryRuntime.replaceSubagentRunAfterSteerCore,
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
      Boolean(fallbackReply) && !isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN);
    const cleanedFallbackReply = hasVisibleFallback
      ? (stripAndClassifyReply(fallbackReply ?? "") ?? undefined)
      : undefined;

    const childRun = subagentRuns.get(params.childRunId);
    if (childRun?.childSessionKey === params.childSessionKey && completionDeliveryAllowed()) {
      ownResult = await readSubagentRunAnnounceResult(childRun);
      reply = ownResult.text;
    }

    if (params.terminalReply?.disposition === "silent") {
      if (!hasVisibleFallback && !expectsCompletionMessage) {
        return "delivered";
      }
      reply = cleanedFallbackReply;
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
      );
      // Empty remains the authoritative terminal fact. Transcript text is a
      // timeout-only progress hint and must never reclassify silence as output.
      if (timeoutProgress) {
        reply = stripAndClassifyReply(timeoutProgress) ?? undefined;
      }
    }
    if (!params.terminalReply) {
      if (
        !reply &&
        allowFailedOutputCapture &&
        (await prepareChildSessionEffects()) &&
        childSessionEffectsAllowed()
      ) {
        reply = await readSubagentOutput(params.childSessionKey, outcome);
      }

      if (
        !reply?.trim() &&
        allowFailedOutputCapture &&
        (await prepareChildSessionEffects()) &&
        childSessionEffectsAllowed()
      ) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          maxWaitMs: params.timeoutMs,
          outcome,
        });
      }

      if (!reply?.trim() && hasVisibleFallback) {
        reply = fallbackReply;
      }

      if (isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        if (hasVisibleFallback && cleanedFallbackReply) {
          reply = cleanedFallbackReply;
        } else {
          if (!expectsCompletionMessage || hasVisibleFallback) {
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

    const childSessionCurrent = await prepareChildSessionEffects();
    if (!ownResult && (!childSessionCurrent || !childSessionEffectsAllowed())) {
      reply = params.roundOneReply ?? params.fallbackReply;
      if (
        expectsCompletionMessage &&
        (params.terminalReply?.disposition === "silent" ||
          isSilentReplyText(reply, SILENT_REPLY_TOKEN))
      ) {
        reply = hasVisibleFallback ? cleanedFallbackReply : undefined;
      }
    }

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
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey, {
            cfg: getRuntimeConfig(),
            agentId: targetRequesterAgentId,
          });
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
            startedAt: params.startedAt,
            endedAt: params.endedAt,
          });
    const statsLine =
      (await prepareChildSessionEffects()) && childSessionEffectsAllowed()
        ? candidateStatsLine
        : undefined;
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
      completionRequesterLifecycleRevision: params.completionRequesterLifecycleRevision,
      directIdempotencyKey,
      onDeliveryResult: reportDeliveryResult,
      signal: params.signal,
      onExecutionStarted: params.onExecutionStarted,
      resolveGatewayContext: params.resolveGatewayContext,
    });
    await reportDeliveryResult(delivery);
    announceOutcome =
      delivery.reason === "requester_turn_pending"
        ? "requester_turn_pending"
        : (delivery.disposition ?? (delivery.delivered ? "delivered" : "retryable"));
  } catch (err) {
    shouldDeleteChildSession = false;
    if (hasSqliteWorkerOutcomeUnknown(err)) {
      throw err;
    }
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
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
        spawnMode: params.spawnMode,
        expectedSessionId: childSessionId,
        expectedLifecycleRevision: childSessionLifecycleRevision,
      });
    }
  }
  return announceOutcome;
}
