import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import { resolveRestartRecoveryTerminalDeliveryDisposition } from "../config/sessions/restart-recovery-receipt-state.js";
import {
  hasMainSessionRecoveryClaim,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import type {
  HarnessCompletionRecovery,
  RestartRecoveryTerminalDeliveryEvidenceResult,
} from "../config/sessions/restart-recovery-types.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
  getOwedHarnessCompletionTask,
} from "./agent-harness-completion-recovery.js";
import { normalizeAgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.js";
import type { AgentCommandOpts } from "./command/types.js";
import {
  collectDeliveredMediaUrls,
  collectMessagingToolDeliveredMediaUrls,
  getAutomaticDeliveryEvidence,
  hasCommittedOutboundDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleAgentPayload,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
  type AgentDeliveryEvidence,
} from "./embedded-agent-runner/delivery-evidence.js";

function normalizeOptionalThreadId(value: unknown): string | undefined {
  return (
    normalizeOptionalString(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)
  );
}

type RestartRecoveryTerminalDeliveryInput = Omit<AgentDeliveryEvidence, "deliveryStatus"> &
  Pick<RestartRecoveryTerminalDeliveryEvidenceResult, "deliveryStatus">;

/** Reduce a terminal result to bounded, route-checkable delivery evidence. */
export function buildRestartRecoveryTerminalDeliveryEvidence(
  result: RestartRecoveryTerminalDeliveryInput,
): RestartRecoveryTerminalDeliveryEvidenceResult {
  const terminalReply = normalizeAgentRunTerminalReplySnapshot(result.meta?.terminalReply);
  const silent = terminalReply?.disposition === "silent";
  const meta: RestartRecoveryTerminalDeliveryEvidenceResult["meta"] = {
    ...(silent ? { terminalReply: { disposition: "silent" as const } } : {}),
    ...(result.meta?.yielded === true ? { yielded: true as const } : {}),
    ...(result.meta?.continuationPending === true ? { continuationPending: true as const } : {}),
    ...(result.meta?.aborted ? { aborted: true as const } : {}),
    ...(result.meta?.error ? { error: true as const } : {}),
  };
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
  const status = rawDeliveryStatus?.status;
  const rawPayloadOutcomes = rawDeliveryStatus?.payloadOutcomes;
  const retainedPayloadOutcomes = rawPayloadOutcomes?.slice(0, 64);
  if (
    retainedPayloadOutcomes &&
    rawPayloadOutcomes &&
    rawPayloadOutcomes.length > 64 &&
    !getAutomaticDeliveryEvidence({
      deliveryStatus: { payloadOutcomes: retainedPayloadOutcomes },
    }).mayHaveSent
  ) {
    // Truncation must not turn an omitted committed/ambiguous send into a safe non-send.
    const sendEvidence = rawPayloadOutcomes.find(
      (outcome, index) =>
        index >= 64 &&
        getAutomaticDeliveryEvidence({ deliveryStatus: { payloadOutcomes: [outcome] } })
          .mayHaveSent,
    );
    if (sendEvidence !== undefined) {
      retainedPayloadOutcomes[63] = sendEvidence;
    }
  }
  const payloadOutcomes = retainedPayloadOutcomes?.map((record) => {
    const reason = normalizeOptionalString(record.reason)?.slice(0, 256);
    const evidence: NonNullable<typeof retainedPayloadOutcomes>[number] = {
      index: record.index,
      status: record.status,
    };
    if (reason) {
      evidence.reason = reason;
    }
    if (record.sentBeforeError !== undefined) {
      evidence.sentBeforeError = record.sentBeforeError;
    }
    return evidence;
  });
  const errorMessage = normalizeOptionalString(rawDeliveryStatus?.errorMessage);
  const reason = normalizeOptionalString(
    getAutomaticDeliveryEvidence(result).suppressionReason ?? rawDeliveryStatus?.reason,
  )?.slice(0, 256);
  const deliveryStatus: RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"] = status
    ? {
        status,
        ...(rawDeliveryStatus?.resultCount !== undefined
          ? { resultCount: rawDeliveryStatus.resultCount }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(reason ? { reason } : {}),
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
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(result.requesterContinuationSettled === true
      ? { requesterContinuationSettled: true as const }
      : {}),
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
  runId: string,
): boolean {
  if (!current || current.sessionId !== sessionId) {
    return false;
  }
  if (current.abortedLastRun !== true) {
    return true;
  }
  // Session Stop is terminal; process shutdown keeps custody. Only the settled
  // command may retire its source claim after execution and delivery owners leave.
  return (
    current.status === "killed" &&
    current.lastRunId === runId &&
    current.restartRecoveryDeliveryRunId === runId &&
    current.lifecycleRunId === undefined &&
    !current.mainRestartRecovery &&
    !current.restartRecoveryRuns?.length &&
    !current.pendingFinalDelivery
  );
}

/** A terminal predecessor must not remain the delivery owner of a newly admitted command. */
export function canReplaceTerminalCommandRecoveryClaim(
  entry: SessionEntry,
  runId: string,
): boolean {
  const previousRunId = entry.restartRecoveryDeliveryRunId;
  return Boolean(
    previousRunId &&
    previousRunId !== runId &&
    !entry.pendingFinalDelivery &&
    !entry.mainRestartRecovery &&
    !entry.restartRecoveryHarnessCompletion &&
    !entry.restartRecoveryBeforeAgentReplyState &&
    !entry.restartRecoveryDeliveryReceiptState &&
    !entry.restartRecoveryDeliveryToolCallId &&
    !entry.restartRecoveryRuns?.some(
      (run) => run.runId !== runId && !hasRestartRecoveryTerminalRun(entry, run.runId),
    ) &&
    resolveRestartRecoveryTerminalDeliveryDisposition(entry, {
      sessionId: entry.sessionId,
      sourceTurnId: entry.restartRecoveryDeliverySourceRunId ?? previousRunId,
    }) === "already-delivered",
  );
}

export function shouldPersistRestartRecoveryContextClaim(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
  allowCreate: boolean,
  previousEntry: SessionEntry,
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
    current.restartRecoveryDeliveryRunId === runId ||
    (canReplaceTerminalCommandRecoveryClaim(previousEntry, runId) &&
      current.lifecycleRevision === previousEntry.lifecycleRevision &&
      current.restartRecoveryDeliveryRunId === previousEntry.restartRecoveryDeliveryRunId &&
      current.restartRecoveryDeliverySourceRunId ===
        previousEntry.restartRecoveryDeliverySourceRunId &&
      canReplaceTerminalCommandRecoveryClaim(current, runId))
  );
}

export function buildCurrentRunRestartRecoveryClaim(params: {
  harnessCompletion?: HarnessCompletionRecovery;
  deliveryContext?: DeliveryContext;
  disableMessageTool?: boolean;
  entry: SessionEntry;
  forceRestartSafeTools?: boolean;
  runId: string;
  operatorSource?: SessionEntry["restartRecoveryOperatorSource"];
  requesterSource?: SessionEntry["restartRecoveryRequesterSource"];
  sourceIngress?: SessionEntry["restartRecoverySourceIngress"];
  sourceRunId?: string;
  sourceReplyDeliveryMode?: SessionEntry["restartRecoverySourceReplyDeliveryMode"];
}): Pick<
  SessionEntry,
  | "restartRecoveryDeliveryContext"
  | "restartRecoveryDeliveryMediaUrls"
  | "restartRecoveryDisableMessageTool"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
  | "restartRecoveryHarnessCompletion"
  | "restartRecoveryForceSafeTools"
  | "restartRecoveryOperatorSource"
  | "restartRecoveryRequesterSource"
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
      restartRecoveryOperatorSource: entry.restartRecoveryOperatorSource,
      restartRecoveryRequesterSource: entry.restartRecoveryRequesterSource,
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
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool:
      createsScopedDeliveryClaim && params.disableMessageTool === true ? true : undefined,
    restartRecoverySuppressTextDelivery: undefined,
    restartRecoveryDeliveryRunId: createsScopedDeliveryClaim ? params.runId : undefined,
    restartRecoveryDeliverySourceRunId: params.sourceRunId,
    restartRecoveryOperatorSource: createsScopedDeliveryClaim ? params.operatorSource : undefined,
    restartRecoveryRequesterSource: createsScopedDeliveryClaim ? params.requesterSource : undefined,
    restartRecoverySourceIngress: createsScopedDeliveryClaim ? params.sourceIngress : undefined,
    restartRecoverySourceReplyDeliveryMode: params.sourceRunId
      ? params.sourceReplyDeliveryMode
      : undefined,
    restartRecoveryForceSafeTools:
      createsScopedDeliveryClaim && params.forceRestartSafeTools === true ? true : undefined,
  };
}

/** Bind internal completion sources and retain an already-admitted recovery claim. */
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
  const internalCompletionSourceRunId =
    opts.inputProvenance?.kind === "inter_session" &&
    opts.inputProvenance.sourceTool === "subagent_settle" &&
    opts.inputProvenance.sourceChannel === "internal" &&
    Boolean(opts.inputProvenance.sourceSessionKey?.trim()) &&
    runId.startsWith("announce:requester-settle:")
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
        internalCompletionSourceRunId || harnessCompletion ? ("internal" as const) : undefined,
      sourceRunId: internalCompletionSourceRunId ?? harnessCompletion?.sourceRunId,
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
}): { opts: AgentCommandOpts } {
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
    return { opts };
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
  return { opts: guarded };
}
