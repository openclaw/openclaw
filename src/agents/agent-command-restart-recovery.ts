import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import { hasMainSessionRecoveryClaim } from "../config/sessions/restart-recovery-state.js";
import type {
  HarnessCompletionRecovery,
  RestartRecoveryTerminalDeliveryEvidenceResult,
} from "../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isAgentMediatedCompletionSourceTool } from "../sessions/input-provenance.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
  getOwedHarnessCompletionTask,
} from "./agent-harness-completion-recovery.js";
import type { AgentCommandOpts } from "./command/types.js";
import {
  collectDeliveredMediaUrls,
  collectMessagingToolDeliveredMediaUrls,
  hasCommittedOutboundDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleAgentPayload,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
  type AgentDeliveryEvidence,
} from "./embedded-agent-runner/delivery-evidence.js";
import { mergeAttemptToolMediaPayloads } from "./embedded-agent-runner/run/tool-media-payloads.js";

/** Restore the exact host-owned delivery constraints before starting a recovery turn. */
export function resolveCommandRecoveryOptions(params: {
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  runId: string;
}): AgentCommandOpts {
  const { sessionEntry: entry } = params;
  const media =
    entry?.restartRecoveryDeliveryRunId === params.runId &&
    Array.isArray(entry.restartRecoveryDeliveryMediaUrls)
      ? entry.restartRecoveryDeliveryMediaUrls
      : undefined;
  const opts =
    media !== undefined
      ? {
          ...params.opts,
          internalDeliveryMediaUrls: [...media],
          internalDeliverySuppressText: entry?.restartRecoverySuppressTextDelivery,
          sourceReplyDeliveryMode: entry?.restartRecoverySourceReplyDeliveryMode,
          disableMessageTool: entry?.restartRecoveryDisableMessageTool,
          forceRestartSafeTools: entry?.restartRecoveryForceSafeTools,
        }
      : params.opts;
  if (
    (opts.internalDeliverySuppressText === true && opts.internalDeliveryMediaUrls === undefined) ||
    ((opts.internalDeliveryMediaUrls !== undefined || opts.internalDeliverySuppressText === true) &&
      (opts.forceRestartSafeTools !== true ||
        opts.disableMessageTool !== true ||
        opts.sourceReplyDeliveryMode !== "automatic"))
  ) {
    throw new Error(
      "internal delivery media constraints require automatic delivery with restart-safe tools and no message tool",
    );
  }
  return opts;
}

function normalizeOptionalThreadId(value: unknown): string | undefined {
  return (
    normalizeOptionalString(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)
  );
}

/** Replace model-selected media with the exact host-owned delivery set. */
export function constrainRestartRecoveryDeliveryPayloads(
  payloads: ReplyPayload[] | undefined,
  mediaUrls: string[],
  suppressText = false,
): ReplyPayload[] {
  const constrained: ReplyPayload[] = [];
  for (const payload of payloads ?? []) {
    const constrainedPayload: ReplyPayload = {};
    if (!suppressText && typeof payload.text === "string") {
      constrainedPayload.text = payload.text;
    }
    for (const flag of [
      "isError",
      "isReasoning",
      "isCommentary",
      "isReasoningSnapshot",
      "isCompactionNotice",
      "isFallbackNotice",
      "isStatusNotice",
    ] as const) {
      if (payload[flag] === true) {
        constrainedPayload[flag] = true;
      }
    }
    if (Object.keys(constrainedPayload).length > 0) {
      constrained.push(constrainedPayload);
    }
  }
  const exactMediaUrls = Array.from(
    new Set(mediaUrls.map((url) => url.trim()).filter((url) => url.length > 0)),
  );
  if (exactMediaUrls.length === 0) {
    return constrained;
  }

  if (!suppressText) {
    const visibleReplyIndex = constrained.findIndex((payload) =>
      hasVisibleAgentPayload(
        { payloads: [payload] },
        {
          includeErrorPayloads: false,
          includeSilentReplyPayloads: false,
          requireTerminalContent: true,
        },
      ),
    );
    const visibleReply = constrained[visibleReplyIndex];
    if (visibleReply) {
      // Recovery owns the exact artifacts; merge them with the actual final
      // reply so automatic delivery cannot emit a caption before its media.
      const [mergedReply] =
        mergeAttemptToolMediaPayloads({
          payloads: [visibleReply],
          toolMediaUrls: exactMediaUrls,
          hostOwnedToolMediaUrls: exactMediaUrls,
          toolTrustedLocalMedia: true,
          sourceReplyDeliveryMode: "automatic",
        }) ?? [];
      if (mergedReply) {
        constrained[visibleReplyIndex] = mergedReply;
        return constrained;
      }
    }
  }

  constrained.push({ mediaUrls: exactMediaUrls, trustedLocalMedia: true });
  return constrained;
}

/** Reduce a terminal result to bounded, route-checkable delivery evidence. */
export function buildRestartRecoveryTerminalDeliveryEvidence(
  result: AgentDeliveryEvidence,
): RestartRecoveryTerminalDeliveryEvidenceResult {
  const rawPayloads = Array.isArray(result.payloads) ? result.payloads : undefined;
  const payloads: RestartRecoveryTerminalDeliveryEvidenceResult["payloads"] = rawPayloads
    ?.slice(0, 64)
    .map((payload) => {
      const mediaUrls = collectDeliveredMediaUrls({ payloads: [payload] });
      const visible = hasVisibleAgentPayload(
        { payloads: [payload] },
        {
          requireTerminalContent: true,
          includeErrorPayloads: false,
          includeReasoningPayloads: false,
          includeSilentReplyPayloads: false,
        },
      );
      const evidence: { mediaUrls?: string[]; visible?: boolean } = { visible };
      if (mediaUrls.length > 0) {
        evidence.mediaUrls = mediaUrls;
      }
      return evidence;
    });
  const payloadsTruncated = rawPayloads && rawPayloads.length > 64 ? (true as const) : undefined;
  const rawDeliveryStatus = result.deliveryStatus;
  const status =
    rawDeliveryStatus?.status === "failed" ||
    rawDeliveryStatus?.status === "partial_failed" ||
    rawDeliveryStatus?.status === "sent" ||
    rawDeliveryStatus?.status === "suppressed"
      ? rawDeliveryStatus.status
      : undefined;
  const rawPayloadOutcomes =
    rawDeliveryStatus && typeof rawDeliveryStatus === "object"
      ? (rawDeliveryStatus as { payloadOutcomes?: unknown }).payloadOutcomes
      : undefined;
  const payloadOutcomes: NonNullable<
    RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"]
  >["payloadOutcomes"] = Array.isArray(rawPayloadOutcomes)
    ? rawPayloadOutcomes.flatMap((record) => {
        if (!isRecord(record)) {
          return [];
        }
        const outcomeStatus =
          record.status === "failed" || record.status === "sent" || record.status === "suppressed"
            ? record.status
            : undefined;
        if (!outcomeStatus || typeof record.index !== "number" || !Number.isInteger(record.index)) {
          return [];
        }
        return [
          {
            index: record.index,
            status: outcomeStatus,
            ...(typeof record.sentBeforeError === "boolean"
              ? { sentBeforeError: record.sentBeforeError }
              : {}),
          },
        ];
      })
    : undefined;
  const errorMessage = normalizeOptionalString(rawDeliveryStatus?.errorMessage);
  const deliveryStatus: RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"] = status
    ? {
        status,
        ...(typeof rawDeliveryStatus?.resultCount === "number" &&
        Number.isSafeInteger(rawDeliveryStatus.resultCount) &&
        rawDeliveryStatus.resultCount >= 0
          ? { resultCount: rawDeliveryStatus.resultCount }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(payloadOutcomes?.length ? { payloadOutcomes } : {}),
      }
    : undefined;
  const rawMessagingToolSentTargets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : undefined;
  const messagingToolSentTargets: RestartRecoveryTerminalDeliveryEvidenceResult["messagingToolSentTargets"] =
    rawMessagingToolSentTargets
      ? rawMessagingToolSentTargets.slice(0, 64).flatMap((record) => {
          if (!isRecord(record)) {
            return [];
          }
          const mediaUrls = collectMessagingToolDeliveredMediaUrls({
            messagingToolSentTargets: [record],
          });
          const visible = hasVisibleCommittedMessagingToolDeliveryEvidence({
            messagingToolSentTargets: [record],
          });
          const evidence: NonNullable<
            RestartRecoveryTerminalDeliveryEvidenceResult["messagingToolSentTargets"]
          >[number] = { visible };
          for (const key of ["provider", "accountId", "to"] as const) {
            const value = normalizeOptionalString(record[key]);
            if (value) {
              evidence[key] = value;
            }
          }
          const threadId = normalizeOptionalThreadId(record.threadId);
          if (threadId) {
            evidence.threadId = threadId;
          }
          if (record.threadImplicit === true) {
            evidence.threadImplicit = true;
          }
          if (record.threadSuppressed === true) {
            evidence.threadSuppressed = true;
          }
          if (typeof record.sourceReplyFinal === "boolean") {
            evidence.sourceReplyFinal = record.sourceReplyFinal;
          }
          if (mediaUrls.length > 0) {
            evidence.mediaUrls = mediaUrls;
          }
          return [evidence];
        })
      : undefined;
  const messagingToolSentTargetsTruncated =
    rawMessagingToolSentTargets && rawMessagingToolSentTargets.length > 64
      ? (true as const)
      : undefined;
  const messagingToolAggregateEvidenceUnaccounted = hasUnaccountedMessagingToolAggregateEvidence(
    result,
  )
    ? (true as const)
    : undefined;
  const restartUnsafeSideEffectsDetected =
    hasCommittedOutboundDeliveryEvidence(result) ||
    result.didSendDeterministicApprovalPrompt === true
      ? (true as const)
      : undefined;
  return {
    captured: true,
    ...(payloads?.length ? { payloads } : {}),
    ...(payloadsTruncated ? { payloadsTruncated } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(messagingToolSentTargets?.length ? { messagingToolSentTargets } : {}),
    ...(messagingToolSentTargetsTruncated ? { messagingToolSentTargetsTruncated } : {}),
    ...(messagingToolAggregateEvidenceUnaccounted
      ? { messagingToolAggregateEvidenceUnaccounted }
      : {}),
    ...(restartUnsafeSideEffectsDetected ? { restartUnsafeSideEffectsDetected } : {}),
  };
}

export function shouldPersistCurrentRunSessionCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
): boolean {
  return (
    current !== undefined && current.sessionId === sessionId && current.abortedLastRun !== true
  );
}

export function shouldPersistRestartRecoveryContextClaim(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
  allowCreate: boolean,
): boolean {
  if (!current) {
    return allowCreate;
  }
  if (
    current.sessionId !== sessionId ||
    (current.abortedLastRun === true && hasMainSessionRecoveryClaim(current))
  ) {
    return false;
  }
  return (
    current.restartRecoveryDeliveryRunId === undefined ||
    current.restartRecoveryDeliveryRunId === runId
  );
}

export function buildCurrentRunRestartRecoveryClaim(params: {
  harnessCompletion?: HarnessCompletionRecovery;
  deliveryContext?: DeliveryContext;
  deliveryMediaUrls?: string[];
  disableMessageTool?: boolean;
  entry: SessionEntry;
  forceRestartSafeTools?: boolean;
  runId: string;
  sourceIngress?: SessionEntry["restartRecoverySourceIngress"];
  sourceRunId?: string;
  sourceReplyDeliveryMode?: SessionEntry["restartRecoverySourceReplyDeliveryMode"];
  suppressTextDelivery?: boolean;
}): Pick<
  SessionEntry,
  | "restartRecoveryDeliveryContext"
  | "restartRecoveryDeliveryMediaUrls"
  | "restartRecoveryDisableMessageTool"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
  | "restartRecoveryHarnessCompletion"
  | "restartRecoveryForceSafeTools"
  | "restartRecoverySourceIngress"
  | "restartRecoverySourceReplyDeliveryMode"
  | "restartRecoverySuppressTextDelivery"
> {
  // Recovery can preclaim a run by id. Preserve its original source semantics
  // while the resumed RPC replaces only the active delivery run id.
  const bindsAdmittedHarnessSource =
    params.harnessCompletion?.sourceRunId === params.runId &&
    params.entry.restartRecoveryDeliverySourceRunId === undefined;
  const adoptsExistingClaim =
    params.entry.restartRecoveryDeliveryRunId === params.runId && !bindsAdmittedHarnessSource;
  if (adoptsExistingClaim) {
    const entry = params.entry;
    return {
      ...(entry.restartRecoveryHarnessCompletion
        ? { restartRecoveryHarnessCompletion: entry.restartRecoveryHarnessCompletion }
        : {}),
      restartRecoveryDeliveryContext: entry.restartRecoveryDeliveryContext,
      restartRecoveryDeliveryMediaUrls: entry.restartRecoveryDeliveryMediaUrls,
      restartRecoveryDisableMessageTool: entry.restartRecoveryDisableMessageTool,
      restartRecoverySuppressTextDelivery: entry.restartRecoverySuppressTextDelivery,
      restartRecoveryDeliveryRunId: params.runId,
      restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
      restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
      restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
      restartRecoveryForceSafeTools: entry.restartRecoveryForceSafeTools,
    };
  }
  const createsScopedDeliveryClaim = params.sourceRunId !== undefined;
  if (createsScopedDeliveryClaim && !params.sourceIngress) {
    throw new Error("restart recovery source ownership is required for a new claim");
  }
  return {
    ...(params.harnessCompletion
      ? { restartRecoveryHarnessCompletion: params.harnessCompletion }
      : params.entry.restartRecoveryHarnessCompletion
        ? { restartRecoveryHarnessCompletion: undefined }
        : {}),
    restartRecoveryDeliveryContext: params.deliveryContext,
    restartRecoveryDeliveryMediaUrls:
      createsScopedDeliveryClaim && params.deliveryMediaUrls !== undefined
        ? [...params.deliveryMediaUrls]
        : undefined,
    restartRecoveryDisableMessageTool:
      createsScopedDeliveryClaim && params.disableMessageTool === true ? true : undefined,
    restartRecoverySuppressTextDelivery:
      createsScopedDeliveryClaim && params.suppressTextDelivery === true ? true : undefined,
    restartRecoveryDeliveryRunId: createsScopedDeliveryClaim ? params.runId : undefined,
    restartRecoveryDeliverySourceRunId: params.sourceRunId,
    restartRecoverySourceIngress: createsScopedDeliveryClaim ? params.sourceIngress : undefined,
    restartRecoverySourceReplyDeliveryMode: params.sourceRunId
      ? params.sourceReplyDeliveryMode
      : undefined,
    restartRecoveryForceSafeTools:
      createsScopedDeliveryClaim && params.forceRestartSafeTools === true ? true : undefined,
  };
}

/** Prepare only an admitted channel completion, or the exact saved recovery claim. */
export function prepareCommandHarnessCompletionRecovery(params: {
  entry: SessionEntry;
  sessionId: string;
  sessionKey: string;
  runId: string;
  agentId: string;
  opts: AgentCommandOpts;
  hasDeliveryContext: boolean;
}) {
  const { entry, sessionId, sessionKey, runId, agentId, opts } = params;
  const harnessCompletion = params.hasDeliveryContext
    ? captureHarnessCompletionRecovery({
        agentId,
        sessionKey,
        entry: { ...entry, sessionId },
        runId,
        inputProvenance: opts.inputProvenance,
      })
    : undefined;
  const generatedMediaSourceRunId =
    opts.internalDeliveryMediaUrls !== undefined &&
    opts.inputProvenance?.kind === "inter_session" &&
    isAgentMediatedCompletionSourceTool(opts.inputProvenance.sourceTool)
      ? runId
      : undefined;
  const claimedHarnessCompletion =
    entry.restartRecoveryDeliveryRunId === runId
      ? entry.restartRecoveryHarnessCompletion
      : undefined;
  const guardedHarnessCompletion = harnessCompletion ?? claimedHarnessCompletion;
  if (guardedHarnessCompletion && !getOwedHarnessCompletionTask(guardedHarnessCompletion, entry)) {
    throw createSessionWorkStartChangedError(sessionKey);
  }
  return {
    harnessCompletion,
    guardedHarnessCompletion,
    isCompletionCurrent: (current: SessionEntry | undefined) =>
      !guardedHarnessCompletion ||
      Boolean(current && getOwedHarnessCompletionTask(guardedHarnessCompletion, current)),
    sourceOptions: {
      sourceIngress:
        generatedMediaSourceRunId || harnessCompletion ? ("internal" as const) : undefined,
      sourceRunId: generatedMediaSourceRunId ?? harnessCompletion?.sourceRunId,
      sourceReplyDeliveryMode:
        opts.sourceReplyDeliveryMode ?? (harnessCompletion ? ("automatic" as const) : undefined),
    },
  };
}

/** Called after the caller has recorded the committed entry for failure cleanup. */
export function bindCommandHarnessCompletionAssertion(params: {
  claim?: HarnessCompletionRecovery;
  persisted?: SessionEntry;
  sessionKey: string;
  storePath?: string;
  opts: AgentCommandOpts;
}): AgentCommandOpts {
  const { claim, persisted, sessionKey, storePath, opts } = params;
  if (
    claim &&
    (!persisted ||
      persisted.restartRecoveryHarnessCompletion?.taskId !== claim.taskId ||
      !getOwedHarnessCompletionTask(claim, persisted))
  ) {
    throw createSessionWorkStartChangedError(sessionKey);
  }
  if (!claim || !storePath) {
    return opts;
  }
  const guarded = {
    ...opts,
    assertSourceCurrent: Object.assign(
      createHarnessCompletionSourceAssertion({
        claim,
        storePath,
        priorAssertion: opts.assertSourceCurrent,
      }),
      { recoveryReference: opts.assertSourceCurrent?.recoveryReference },
    ),
  };
  guarded.assertSourceCurrent();
  return guarded;
}
