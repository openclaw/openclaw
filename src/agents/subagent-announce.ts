import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../auto-reply/tokens.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import {
  type AgentTaskCompletionDedupeMetadata,
  type AgentTaskCompletionDeliveryAction,
  type AgentTaskCompletionDeliveryState,
  type AgentTaskCompletionStatusCard,
} from "./internal-event-contract.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  buildActiveTaskChildCompletionDedupeKey,
  buildActiveTaskStatusCardData,
  readActiveTaskContractFromEnv,
} from "./subagent-active-task-contract.js";
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
  isEmbeddedPiRunActive,
  getRuntimeConfig,
  waitForEmbeddedPiRunEnd,
} from "./subagent-announce.runtime.js";
import {
  buildChildCompletionResultHash,
  buildParentVisibleChildResult,
  parseChildResultReport,
  CHILD_RESULT_DUPLICATE_COMPLETION,
  CHILD_RESULT_FAILED_GATES,
  CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT,
  CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
  CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
  CHILD_RESULT_MISSING_VERDICT_SCHEMA,
  CHILD_RESULT_REJECTED,
  CHILD_RESULT_SCHEMA_VALID,
  CHILD_RESULT_TASK_CONTRACT_MISSING,
  CHILD_RESULT_EVIDENCE_UNVERIFIED,
  type ChildResultClassification,
  type ChildResultParentRuntimeEvidence,
  type ChildResultRetryAttempt,
  type ChildResultRetryPolicyDecision,
  type ChildResultScopeCheck,
  type ChildResultScopedGateProcess,
} from "./subagent-child-result-contract.js";
import { renderChildResultDashboardStatus } from "./subagent-child-result-rollout.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type {
  SubagentChildResultRetryAttemptRecord,
  SubagentChildResultRetryPolicyRecord,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import {
  collectSubagentStaleProcessSweep,
  shouldRunSubagentStaleProcessSweep,
  SUBAGENT_STALE_PROCESS_RISK,
} from "./subagent-stale-process-sweep.js";
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

type ChildCompletionDeliveryPolicy = {
  deliveryState: AgentTaskCompletionDeliveryState;
  action: AgentTaskCompletionDeliveryAction;
  userDeliveryEligible: boolean;
  userVisibleSuppressed?: boolean;
  userVisibleSuppressedReason?: string;
};

type ChildCompletionDedupeDecision = {
  metadata: AgentTaskCompletionDedupeMetadata;
  duplicateCompletion: boolean;
  parentEventSuppressed: boolean;
  backgrounded: boolean;
};

type ChildCompletionDedupeCounter = {
  seenCount: number;
  duplicateCount: number;
};

type CompletionStatusProvenance = {
  childRunId?: string;
  childSessionKey?: string;
  childSessionId?: string;
  requesterSessionKey?: string;
  taskLabel?: string;
};

const childCompletionDedupeCounters = new Map<string, ChildCompletionDedupeCounter>();

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function registryRunMatchesChildRun(entry: unknown, childRunId: string): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const entryRunId = (entry as { runId?: unknown }).runId;
  if (typeof entryRunId !== "string" || !entryRunId.trim()) {
    return true;
  }
  return entryRunId.trim() === childRunId.trim();
}

function registryRunHasCompletionMarker(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const typed = entry as {
    completionAnnouncedAt?: unknown;
    completionDeliveredAt?: unknown;
  };
  return (
    finiteTimestamp(typed.completionAnnouncedAt) !== undefined ||
    finiteTimestamp(typed.completionDeliveredAt) !== undefined
  );
}

function latestRegistryRunIndicatesDuplicateCompletion(params: {
  latestRun: unknown;
  childRunId: string;
}): boolean {
  return (
    registryRunMatchesChildRun(params.latestRun, params.childRunId) &&
    registryRunHasCompletionMarker(params.latestRun)
  );
}

function resolveAnnounceActiveTaskContract(explicit: unknown | undefined): unknown | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const envContract = readActiveTaskContractFromEnv();
  return envContract.ok ? envContract.contract : undefined;
}

function buildChildCompletionDedupeDecision(params: {
  activeTaskContract?: unknown;
  activeTaskContractId?: string;
  childRunId: string;
  childSessionId?: string;
  childSessionKey: string;
  childTaskId?: string;
  resultText?: string | null;
  duplicateHint?: boolean;
}): ChildCompletionDedupeDecision {
  const resultHash = buildChildCompletionResultHash(params.resultText);
  const keyInfo = buildActiveTaskChildCompletionDedupeKey({
    activeTaskContract: params.activeTaskContract,
    activeTaskContractId: params.activeTaskContractId,
    childRunId: params.childRunId,
    childSessionId: params.childSessionId,
    childSessionKey: params.childSessionKey,
    childTaskId: params.childTaskId,
    resultHash,
  });
  const existing = childCompletionDedupeCounters.get(keyInfo.key);
  const duplicateHint = params.duplicateHint === true;
  const priorSeenCount = existing?.seenCount ?? 0;
  const seenCount = priorSeenCount + 1 + (priorSeenCount === 0 && duplicateHint ? 1 : 0);
  const duplicateCount = Math.max(0, seenCount - 1);
  const duplicateCompletion = duplicateHint || priorSeenCount > 0;
  const parentEventSuppressed = duplicateCompletion && duplicateCount > 1;
  childCompletionDedupeCounters.set(keyInfo.key, { seenCount, duplicateCount });
  return {
    duplicateCompletion,
    parentEventSuppressed,
    metadata: {
      key: keyInfo.key,
      resultHash,
      seenCount,
      deliveredCount: 0,
      duplicateCount,
      suppressedCount: duplicateCount,
      backgroundedCount: keyInfo.backgrounded ? seenCount : 0,
      duplicate: duplicateCompletion,
      parentEventSuppressed,
      activeTaskContractId: keyInfo.components.activeTaskContractId,
      childRunId: params.childRunId,
      childSessionId: keyInfo.components.childSessionId,
      taskId: keyInfo.components.taskId,
    },
    backgrounded: keyInfo.backgrounded,
  };
}

function completionRecordContractVerdict(entry: SubagentRunRecord): string | undefined {
  const records = entry.completionDedupeRecords ? Object.values(entry.completionDedupeRecords) : [];
  const candidates = [entry.completionDedupe, ...records].filter(Boolean) as NonNullable<
    SubagentRunRecord["completionDedupe"]
  >[];
  candidates.sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0));
  return candidates.find((record) => record.lastNormalizedResult?.contractVerdict)
    ?.lastNormalizedResult?.contractVerdict;
}

function retryAttemptFromRunRecord(entry: SubagentRunRecord): ChildResultRetryAttempt | undefined {
  const stored =
    entry.completionDedupe?.lastChildResultRetryAttempt ?? entry.childResultRetryAttempt;
  const fallback: ChildResultRetryAttempt = {
    mechanismKey: stored?.mechanismKey ?? entry.spawnMode ?? "subagent",
    mechanismChanges: stored?.mechanismChanges,
    profileKey: stored?.profileKey ?? entry.model ?? "default",
    promptHash: stored?.promptHash,
    prompt: stored?.promptHash ? undefined : entry.task,
    contractVerdict: stored?.contractVerdict ?? completionRecordContractVerdict(entry),
  };
  if (
    !fallback.contractVerdict &&
    !fallback.mechanismKey &&
    !fallback.promptHash &&
    !fallback.prompt
  ) {
    return undefined;
  }
  return fallback;
}

function currentRetryAttemptFromRunRecord(params: {
  entry?: SubagentRunRecord | null;
  task: string;
  spawnMode?: SpawnSubagentMode;
}): Pick<
  ChildResultRetryAttempt,
  "mechanismKey" | "mechanismChanges" | "profileKey" | "promptHash" | "prompt"
> {
  const stored = params.entry?.childResultRetryAttempt;
  return {
    mechanismKey: stored?.mechanismKey ?? params.entry?.spawnMode ?? params.spawnMode ?? "subagent",
    mechanismChanges: stored?.mechanismChanges,
    profileKey: stored?.profileKey ?? params.entry?.model ?? "default",
    promptHash: stored?.promptHash,
    prompt: stored?.promptHash ? undefined : params.task,
  };
}

function retryPolicyRecord(
  decision: ChildResultRetryPolicyDecision | undefined,
): SubagentChildResultRetryPolicyRecord | undefined {
  if (!decision) {
    return undefined;
  }
  return {
    verdict: decision.verdict,
    retryAllowed: decision.retryAllowed,
    directVerificationRequired: decision.directVerificationRequired,
    nextMechanismKey: decision.nextMechanismKey,
    nextAttemptFingerprint: decision.nextAttemptFingerprint,
    sameMechanismMalformedRetries: decision.sameMechanismMalformedRetries,
    sameAttemptFingerprintMalformedRetries: decision.sameAttemptFingerprintMalformedRetries,
    acceptedMechanismChanges: decision.acceptedMechanismChanges,
    changedProfileOrPrompt: decision.changedProfileOrPrompt,
    reasons: decision.reasons,
  };
}

function retryAttemptRecord(params: {
  attempt: Pick<
    ChildResultRetryAttempt,
    "mechanismKey" | "mechanismChanges" | "profileKey" | "promptHash" | "prompt"
  >;
  contractVerdict: string;
}): SubagentChildResultRetryAttemptRecord {
  return {
    contractVerdict: params.contractVerdict,
    mechanismKey: params.attempt.mechanismKey,
    mechanismChanges: params.attempt.mechanismChanges,
    profileKey: params.attempt.profileKey,
    promptHash: params.attempt.promptHash,
    recordedAt: Date.now(),
  };
}

const MALFORMED_OR_MISSING_CHILD_VERDICTS = new Set<string>([
  CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT,
  CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
  CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
  CHILD_RESULT_MISSING_VERDICT_SCHEMA,
  CHILD_RESULT_TASK_CONTRACT_MISSING,
  CHILD_RESULT_EVIDENCE_UNVERIFIED,
]);

function resolveChildCompletionDeliveryPolicy(
  classification: ChildResultClassification,
): ChildCompletionDeliveryPolicy {
  if (classification.contractVerdict === CHILD_RESULT_DUPLICATE_COMPLETION) {
    return {
      deliveryState: "suppressed_duplicate",
      action: "suppress_user_visible_delivery",
      userDeliveryEligible: false,
      userVisibleSuppressed: true,
      userVisibleSuppressedReason: "DUPLICATE_COMPLETION",
    };
  }

  if (
    classification.transportOutcome === "failed" ||
    classification.transportOutcome === "timeout" ||
    classification.contractVerdict === CHILD_RESULT_FAILED_GATES ||
    classification.contractVerdict === CHILD_RESULT_REJECTED
  ) {
    return {
      deliveryState: "rework_required",
      action: "report_blocker_or_rework",
      userDeliveryEligible: true,
    };
  }

  if (
    classification.acceptanceEligible &&
    classification.contractVerdict === CHILD_RESULT_SCHEMA_VALID
  ) {
    return {
      deliveryState: "accepted",
      action: "summarize_verified_result",
      userDeliveryEligible: true,
    };
  }

  const knownValidationVerdict = MALFORMED_OR_MISSING_CHILD_VERDICTS.has(
    classification.contractVerdict,
  );
  if (classification.retryPolicy?.directVerificationRequired === true) {
    return {
      deliveryState: "validation_required",
      action: "report_blocker_or_rework",
      userDeliveryEligible: false,
      userVisibleSuppressed: true,
      userVisibleSuppressedReason: "DIRECT_VERIFICATION_REQUIRED",
    };
  }
  return {
    deliveryState: classification.quarantineArtifact ? "quarantined" : "validation_required",
    action: knownValidationVerdict ? "validate_artifact_or_retry" : "report_blocker_or_rework",
    userDeliveryEligible: false,
    userVisibleSuppressed: true,
    userVisibleSuppressedReason: classification.quarantineArtifact
      ? "RAW_BODY_QUARANTINED"
      : "NOT_ACCEPTANCE_ELIGIBLE",
  };
}

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  deliveryPolicy: ChildCompletionDeliveryPolicy;
}): string {
  const keepPrivate =
    "Keep this internal context private (don't mention system/log/stats/session details or announce type).";
  const useSafeMetadataOnly =
    "Use only status-card metadata and safe summaries; never quote or re-emit raw child output.";
  if (params.deliveryPolicy.deliveryState === "suppressed_duplicate") {
    return `Duplicate ${params.announceType} completion suppressed. Do not send a user-facing update. ${useSafeMetadataOnly} ${keepPrivate}`;
  }
  if (params.deliveryPolicy.userVisibleSuppressedReason === "DIRECT_VERIFICATION_REQUIRED") {
    return `This ${params.announceType} hit the malformed-output retry limit for the same mechanism/profile/prompt. ${useSafeMetadataOnly} Stop identical retry and do direct parent/runtime verification or report a blocker. ${keepPrivate}`;
  }
  if (params.deliveryPolicy.action === "validate_artifact_or_retry") {
    return `This ${params.announceType} completion is not accepted by contract. ${useSafeMetadataOnly} Validate the artifact or request child rework before any user-facing completion update. ${keepPrivate}`;
  }
  if (params.deliveryPolicy.action === "report_blocker_or_rework") {
    return params.requesterIsSubagent
      ? `Convert this completion into a concise internal blocker/rework update for your parent agent in your own words. ${useSafeMetadataOnly} ${keepPrivate}`
      : `Report the blocker or rework state truthfully if a user update is needed; do not present the task as completed. ${useSafeMetadataOnly} ${keepPrivate}`;
  }

  if (params.requesterIsSubagent) {
    return `Convert this verified completion into a concise internal orchestration update for your parent agent in your own words. ${useSafeMetadataOnly} ${keepPrivate}`;
  }
  if (params.expectsCompletionMessage) {
    return `Summarize the verified ${params.announceType} result for the user in your normal assistant voice. ${useSafeMetadataOnly} If the runtime marks this route as message-tool-only, send visible output with the message tool first, then use the structured silent-reply suppression control to avoid duplicate final text. ${keepPrivate}`;
  }
  return `Summarize the verified ${params.announceType} result for the user in your normal assistant voice. Do not copy internal event text verbatim. ${useSafeMetadataOnly} ${keepPrivate}`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

function buildCompletionStatusLabel(params: {
  outcome: SubagentRunOutcome;
  deliveryPolicy: ChildCompletionDeliveryPolicy;
}): string {
  if (params.deliveryPolicy.action === "summarize_verified_result") {
    return "verified completion; summarize for user or parent review";
  }
  if (params.deliveryPolicy.action === "report_blocker_or_rework") {
    if (params.outcome.status === "timeout") {
      return "timed out; blocker/rework report required";
    }
    if (params.outcome.status === "error") {
      return `failed; blocker/rework report required: ${params.outcome.error || "unknown error"}`;
    }
    return "blocked or rejected; rework report required";
  }
  if (params.deliveryPolicy.deliveryState === "suppressed_duplicate") {
    return "duplicate completion suppressed";
  }
  return params.deliveryPolicy.deliveryState === "quarantined"
    ? "child result quarantined; validation required"
    : "child result not accepted; validation required";
}

function uniqueStatusLabels(values: Array<string | undefined | false>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function buildCompletionStatusLabels(params: {
  classification: ChildResultClassification;
  deliveryPolicy: ChildCompletionDeliveryPolicy;
  notAcceptanceEvidence: boolean;
  verifierDecision: string;
}): string[] {
  return uniqueStatusLabels([
    ...(params.classification.classificationLabels ?? []),
    params.deliveryPolicy.deliveryState === "quarantined" && "MALFORMED_QUARANTINED",
    params.classification.normalizedState === "UNVERIFIED" && "UNVERIFIED",
    params.verifierDecision === "EVIDENCE_UNVERIFIED" && "EVIDENCE_UNVERIFIED",
    params.notAcceptanceEvidence && "NOT_ACCEPTANCE_EVIDENCE",
    params.deliveryPolicy.deliveryState === "suppressed_duplicate" &&
      "DUPLICATE_ANNOUNCE_SUPPRESSED",
    params.classification.normalizedState === "INFRA_BLOCKED" && "INFRA_BLOCKED",
  ]);
}

function buildCompletionDebugRefs(params: {
  classification: ChildResultClassification;
  payloadHash?: string;
  byteCount?: number;
  dedupe?: AgentTaskCompletionDedupeMetadata;
}): AgentTaskCompletionStatusCard["debugRefs"] {
  const refs = {
    ...(params.classification.quarantineArtifact?.artifactId
      ? { artifactId: params.classification.quarantineArtifact.artifactId }
      : {}),
    ...(params.payloadHash ? { payloadHash: params.payloadHash } : {}),
    ...(params.dedupe?.resultHash ? { resultHash: params.dedupe.resultHash } : {}),
    ...(params.byteCount !== undefined ? { byteCount: params.byteCount } : {}),
  };
  return Object.keys(refs).length > 0 ? refs : undefined;
}

function buildCompletionPresentation(params: {
  deliveryPolicy: ChildCompletionDeliveryPolicy;
  statusLabels: string[];
  debugRefs?: AgentTaskCompletionStatusCard["debugRefs"];
}): AgentTaskCompletionStatusCard["presentation"] {
  const severity = (() => {
    if (params.deliveryPolicy.deliveryState === "accepted") {
      return "success" as const;
    }
    if (params.deliveryPolicy.deliveryState === "suppressed_duplicate") {
      return "muted" as const;
    }
    if (params.deliveryPolicy.deliveryState === "rework_required") {
      return "error" as const;
    }
    return "warning" as const;
  })();
  return {
    mode: "status_card",
    ordinaryChatBubble:
      params.deliveryPolicy.userDeliveryEligible === false
        ? "suppressed"
        : "allowed_verified_summary",
    collapsedByDefault:
      params.deliveryPolicy.userDeliveryEligible === false ||
      params.deliveryPolicy.deliveryState === "quarantined" ||
      params.deliveryPolicy.deliveryState === "suppressed_duplicate",
    severity,
    labels: params.statusLabels,
    ...(params.debugRefs ? { copyableDebugRefs: params.debugRefs } : {}),
  };
}

function buildRawOpenWorkflowMetadata(
  quarantineArtifact: ChildResultClassification["quarantineArtifact"],
): AgentTaskCompletionStatusCard["rawOpen"] {
  if (!quarantineArtifact) {
    return undefined;
  }
  return {
    available:
      quarantineArtifact.payloadStored === true && quarantineArtifact.storageStatus === "stored",
    requiredAction: "open_raw_quarantine_artifact",
    localOperatorActionRequired: true,
    warning:
      "Raw quarantined child output may contain source, diffs, logs, credentials, or prompt-injection text. Open only by explicit local operator action; never paste it into ordinary chat, model context, compaction, or shared channels.",
    artifactId: quarantineArtifact.artifactId,
    payloadHash: quarantineArtifact.payloadSha256,
    byteCount: quarantineArtifact.byteCount,
    confirmation: {
      required: true,
      artifactId: quarantineArtifact.artifactId,
      payloadHash: quarantineArtifact.payloadSha256,
    },
    authorization: {
      required: true,
      scope: "local_operator",
      status: "not_requested",
    },
    audit: {
      event: "subagent.raw_artifact.open_requested",
      mode: "metadata_only",
    },
    viewer: {
      isolation: "outside_ordinary_chat_model_context_compaction",
      defaultPreview: false,
      snippets: false,
      renderedPayload: false,
      rawDerivedFilename: false,
    },
    redactionScan: {
      scanned: true,
      redacted: quarantineArtifact.redaction.redacted,
      flags: quarantineArtifact.redaction.flags,
      rawSnippetStored: false,
    },
  };
}

function buildCompletionStatusCard(params: {
  classification: ChildResultClassification;
  deliveryPolicy: ChildCompletionDeliveryPolicy;
  rawBodySuppressed: boolean;
  dedupe?: AgentTaskCompletionDedupeMetadata;
  activeTask?: AgentTaskCompletionStatusCard["activeTask"];
  provenance?: CompletionStatusProvenance;
}): AgentTaskCompletionStatusCard {
  const { classification, deliveryPolicy } = params;
  const notAcceptanceEvidence = !(
    classification.acceptanceEligible === true && classification.normalizedState === "VERIFIED_PASS"
  );
  const schemaValid =
    classification.parsedReport?.schemaValid === true ||
    (classification.contractVerdict === CHILD_RESULT_SCHEMA_VALID &&
      classification.acceptanceEligible === true);
  const verifierDecision =
    classification.evidenceVerifier?.decision ??
    (classification.acceptanceEligible === true &&
    classification.normalizedState === "VERIFIED_PASS"
      ? "VERIFIED_PASS"
      : "EVIDENCE_UNVERIFIED");
  const evidenceReasons = classification.evidenceVerifier?.reasons?.length
    ? classification.evidenceVerifier.reasons
    : undefined;
  const quarantine = classification.quarantineArtifact
    ? ({
        sha256: classification.quarantineArtifact.payloadSha256,
        sizeBytes: classification.quarantineArtifact.byteCount,
        storedSizeBytes: classification.quarantineArtifact.storedSizeBytes,
        source: classification.quarantineArtifact.source,
        capturedAt: classification.quarantineArtifact.capturedAt,
        truncated: classification.quarantineArtifact.truncated,
        redacted: classification.quarantineArtifact.redacted,
        reason: classification.quarantineArtifact.reason,
        artifactId: classification.quarantineArtifact.artifactId,
        payloadSha256: classification.quarantineArtifact.payloadSha256,
        payloadHash: classification.quarantineArtifact.payloadSha256,
        byteCount: classification.quarantineArtifact.byteCount,
        storageStatus: classification.quarantineArtifact.storageStatus,
        payloadStored: classification.quarantineArtifact.payloadStored,
      } as AgentTaskCompletionStatusCard["quarantine"] & Record<string, unknown>)
    : undefined;
  const payloadHash = classification.quarantineArtifact?.payloadSha256 ?? params.dedupe?.resultHash;
  const byteCount = classification.quarantineArtifact?.byteCount;
  const statusLabels = buildCompletionStatusLabels({
    classification,
    deliveryPolicy,
    notAcceptanceEvidence,
    verifierDecision,
  });
  const debugRefs = buildCompletionDebugRefs({
    classification,
    payloadHash,
    byteCount,
    dedupe: params.dedupe,
  });
  const presentation = buildCompletionPresentation({
    deliveryPolicy,
    statusLabels,
    debugRefs,
  });
  const dashboard = renderChildResultDashboardStatus(classification);
  const rawOpen = buildRawOpenWorkflowMetadata(classification.quarantineArtifact);
  const sanitizedMetadata = classification.sanitizedMetadata;
  const evidenceVerifier = sanitizedMetadata?.evidenceVerifier ?? classification.evidenceVerifier;
  const retryPolicy = retryPolicyRecord(classification.retryPolicy);
  const provenanceEntries = Object.entries(params.provenance ?? {}).filter(
    ([, value]) => typeof value === "string" && value.trim(),
  );
  const provenance =
    provenanceEntries.length > 0 ? Object.fromEntries(provenanceEntries) : undefined;
  return {
    kind: "subagent_completion_status",
    schemaVersion: classification.schemaVersion,
    normalizedState: classification.normalizedState,
    classificationLabels: classification.classificationLabels,
    labels: statusLabels,
    presentation,
    dashboard,
    ...(debugRefs ? { debugRefs } : {}),
    schemaValid,
    notAcceptanceEvidence,
    verifierDecision,
    ...(classification.evidenceVerifier
      ? {
          evidenceParentObserved: classification.evidenceVerifier.parentObserved,
          ...(classification.evidenceVerifier.observedBy
            ? { evidenceObservedBy: classification.evidenceVerifier.observedBy }
            : {}),
          ...(evidenceReasons ? { evidenceReasons } : {}),
        }
      : {}),
    ...(payloadHash ? { payloadHash } : {}),
    ...(byteCount !== undefined ? { byteCount } : {}),
    deliveryState: deliveryPolicy.deliveryState,
    action: deliveryPolicy.action,
    transportOutcome: classification.transportOutcome,
    contractVerdict: classification.contractVerdict,
    acceptanceEligible: classification.acceptanceEligible,
    reasons: classification.reasons,
    ...(quarantine ? { quarantine } : {}),
    ...(rawOpen ? { rawOpen } : {}),
    ...(sanitizedMetadata?.verifiedArtifacts?.length
      ? { verifiedArtifacts: sanitizedMetadata.verifiedArtifacts }
      : {}),
    ...(evidenceVerifier ? { evidenceVerifier } : {}),
    ...(retryPolicy ? { retryPolicy } : {}),
    rawBodySuppressed: params.rawBodySuppressed,
    ...(deliveryPolicy.userVisibleSuppressed !== undefined
      ? { userVisibleSuppressed: deliveryPolicy.userVisibleSuppressed }
      : {}),
    ...(deliveryPolicy.userVisibleSuppressedReason
      ? { userVisibleSuppressedReason: deliveryPolicy.userVisibleSuppressedReason }
      : {}),
    ...(params.dedupe ? { dedupe: params.dedupe } : {}),
    ...(params.activeTask ? { activeTask: params.activeTask } : {}),
    ...(provenance ? { provenance } : {}),
  } as AgentTaskCompletionStatusCard;
}

export function buildChildCompletionDeliveryDecision(params: {
  classification: ChildResultClassification;
  rawBodySuppressed: boolean;
  outcome: SubagentRunOutcome;
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  dedupe?: AgentTaskCompletionDedupeMetadata;
  activeTask?: AgentTaskCompletionStatusCard["activeTask"];
  provenance?: CompletionStatusProvenance;
}): {
  deliveryPolicy: ChildCompletionDeliveryPolicy;
  replyInstruction: string;
  statusCard: AgentTaskCompletionStatusCard;
  statusLabel: string;
} {
  const deliveryPolicy = resolveChildCompletionDeliveryPolicy(params.classification);
  return {
    deliveryPolicy,
    replyInstruction: buildAnnounceReplyInstruction({
      requesterIsSubagent: params.requesterIsSubagent,
      announceType: params.announceType,
      expectsCompletionMessage: params.expectsCompletionMessage,
      deliveryPolicy,
    }),
    statusCard: buildCompletionStatusCard({
      classification: params.classification,
      deliveryPolicy,
      rawBodySuppressed: params.rawBodySuppressed,
      dedupe: params.dedupe,
      activeTask: params.activeTask,
      provenance: params.provenance,
    }),
    statusLabel: buildCompletionStatusLabel({ outcome: params.outcome, deliveryPolicy }),
  };
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

  let wakeRunId = "";
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
  });
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  workspaceDir?: string;
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
  activeTaskContract?: unknown;
  childTaskId?: string;
  parentRuntimeEvidence?: ChildResultParentRuntimeEvidence;
  parentScopeCheck?: ChildResultScopeCheck;
  scopedGateProcesses?: ChildResultScopedGateProcess[];
  parentPostflightHashes?: Record<string, string>;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
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
    if (childSessionId && isEmbeddedPiRunActive(childSessionId)) {
      const settled = await waitForEmbeddedPiRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedPiRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        return false;
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
            return true;
          }
          reply = cleaned;
        } else {
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

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";
    const activeTaskContract = resolveAnnounceActiveTaskContract(params.activeTaskContract);
    const identityResultText = childCompletionFindings ?? reply;
    const parsedIdentity = parseChildResultReport(identityResultText ?? "");
    const childTaskId =
      params.childTaskId ?? parsedIdentity?.taskId ?? parsedIdentity?.activeTaskContractId;
    let latestRunForChild: SubagentRunRecord | null | undefined;
    const duplicateHintFromRegistry = (() => {
      try {
        latestRunForChild = subagentRegistryRuntime?.getLatestSubagentRunByChildSessionKey?.(
          params.childSessionKey,
        ) as SubagentRunRecord | null | undefined;
        return latestRegistryRunIndicatesDuplicateCompletion({
          latestRun: latestRunForChild,
          childRunId: params.childRunId,
        });
      } catch {
        return false;
      }
    })();
    let completionDedupe = buildChildCompletionDedupeDecision({
      activeTaskContract,
      activeTaskContractId: parsedIdentity?.activeTaskContractId,
      childRunId: params.childRunId,
      childSessionId,
      childSessionKey: params.childSessionKey,
      childTaskId,
      resultText: identityResultText,
      duplicateHint: duplicateHintFromRegistry,
    });
    if (subagentRegistryRuntime?.beginSubagentCompletionDedupe) {
      try {
        const dedupeBegin = subagentRegistryRuntime.beginSubagentCompletionDedupe({
          childRunId: params.childRunId,
          childSessionKey: params.childSessionKey,
          dedupeKey: completionDedupe.metadata.key,
          activeTaskContractId: completionDedupe.metadata.activeTaskContractId ?? "unknown",
          childSessionId: completionDedupe.metadata.childSessionId ?? announceSessionId,
          taskId: completionDedupe.metadata.taskId ?? "unknown",
          resultHash: completionDedupe.metadata.resultHash,
          backgrounded: completionDedupe.backgrounded,
        });
        const registryDuplicate = dedupeBegin.duplicate === true;
        const duplicateCompletion = completionDedupe.duplicateCompletion || registryDuplicate;
        const registrySeenCount = Math.max(1, dedupeBegin.counters.seenCount ?? 1);
        const registryDeliveredCount = Math.max(0, dedupeBegin.counters.deliveredCount ?? 0);
        const registryDuplicateCount = Math.max(0, dedupeBegin.counters.duplicateCount ?? 0);
        const registrySuppressedCount = Math.max(0, dedupeBegin.counters.suppressedCount ?? 0);
        const registryBackgroundedCount = Math.max(0, dedupeBegin.counters.backgroundedCount ?? 0);
        const parentEventSuppressed =
          completionDedupe.parentEventSuppressed ||
          (registryDuplicate && registryDuplicateCount > 1);
        completionDedupe = {
          ...completionDedupe,
          duplicateCompletion,
          parentEventSuppressed,
          metadata: {
            ...completionDedupe.metadata,
            seenCount: Math.max(completionDedupe.metadata.seenCount, registrySeenCount),
            deliveredCount: Math.max(
              completionDedupe.metadata.deliveredCount ?? 0,
              registryDeliveredCount,
            ),
            duplicateCount: Math.max(
              completionDedupe.metadata.duplicateCount,
              registryDuplicateCount,
            ),
            suppressedCount: Math.max(
              completionDedupe.metadata.suppressedCount ?? 0,
              registrySuppressedCount,
            ),
            backgroundedCount: Math.max(
              completionDedupe.metadata.backgroundedCount ?? 0,
              registryBackgroundedCount,
            ),
            duplicate: duplicateCompletion,
            parentEventSuppressed,
          },
        };
      } catch {
        // Best-effort idempotency bookkeeping; keep fallback in-memory suppression.
      }
    }
    if (completionDedupe.parentEventSuppressed) {
      params.onDeliveryResult?.({ delivered: true, path: "none" });
      didAnnounce = true;
      return true;
    }
    const duplicateCompletion = completionDedupe.duplicateCompletion;
    const staleProcessParentRuntimeEvidence = (() => {
      if (params.parentRuntimeEvidence?.staleProcessSweep) {
        return params.parentRuntimeEvidence;
      }
      if (
        !shouldRunSubagentStaleProcessSweep({
          task: params.task,
          outcomeStatus: outcome.status,
        })
      ) {
        return params.parentRuntimeEvidence;
      }
      const sweep = collectSubagentStaleProcessSweep({
        childRunId: params.childRunId,
        childSessionKey: params.childSessionKey,
        workspaceDir: params.workspaceDir,
      });
      if (sweep.status !== SUBAGENT_STALE_PROCESS_RISK) {
        return params.parentRuntimeEvidence;
      }
      const observedAtMs = Date.now();
      return {
        ...(params.parentRuntimeEvidence ?? {}),
        observedBy: params.parentRuntimeEvidence?.observedBy ?? "parent_runtime",
        observedAtMs: params.parentRuntimeEvidence?.observedAtMs ?? observedAtMs,
        childRunId: params.parentRuntimeEvidence?.childRunId ?? params.childRunId,
        childSessionKey: params.parentRuntimeEvidence?.childSessionKey ?? params.childSessionKey,
        staleProcessSweep: {
          status: SUBAGENT_STALE_PROCESS_RISK,
          noRunningProcesses: false,
          observedAtMs,
          childRunId: params.childRunId,
          childSessionKey: params.childSessionKey,
        },
      } satisfies ChildResultParentRuntimeEvidence;
    })();
    const previousRetryAttempts = (() => {
      try {
        const runs = subagentRegistryRuntime?.listSubagentRunsForRequester?.(
          params.requesterSessionKey,
        );
        if (!Array.isArray(runs)) {
          return [];
        }
        return runs
          .filter((entry): entry is SubagentRunRecord =>
            Boolean(entry && entry.runId !== params.childRunId),
          )
          .map((entry) => retryAttemptFromRunRecord(entry))
          .filter((attempt): attempt is ChildResultRetryAttempt => Boolean(attempt));
      } catch {
        return [];
      }
    })();
    const currentRetryAttempt = currentRetryAttemptFromRunRecord({
      entry: latestRunForChild,
      task: params.task,
      spawnMode: params.spawnMode,
    });
    const parentVisibleChildResult = buildParentVisibleChildResult({
      rawText: duplicateCompletion && !reply?.trim() ? childCompletionFindings : reply,
      rawSource: "assistant_output",
      outcome,
      duplicateCompletion,
      activeTaskContract,
      childTaskId,
      spawnedAtMs: params.startedAt,
      parentPostflightHashes: params.parentPostflightHashes,
      parentScopeCheck: params.parentScopeCheck,
      scopedGateProcesses: params.scopedGateProcesses,
      parentRuntimeEvidence: staleProcessParentRuntimeEvidence,
      childSessionKey: params.childSessionKey,
      childSessionId: announceSessionId,
      childRunId: params.childRunId,
      requesterSessionKey: targetRequesterSessionKey,
      taskLabel,
      previousRetryAttempts,
      currentRetryAttempt,
    });
    const findings = duplicateCompletion
      ? parentVisibleChildResult.parentVisibleText || "(duplicate completion suppressed)"
      : childCompletionFindings || parentVisibleChildResult.parentVisibleText || "(no output)";
    const activeTaskStatusCard = activeTaskContract
      ? buildActiveTaskStatusCardData({
          activeTaskContract,
          childTaskId,
          outputArtifactPaths:
            parentVisibleChildResult.classification.parsedReport?.outputArtifactPaths ??
            parsedIdentity?.outputArtifactPaths,
        })
      : undefined;

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

    const completionDecision = buildChildCompletionDeliveryDecision({
      classification: parentVisibleChildResult.classification,
      rawBodySuppressed: parentVisibleChildResult.rawBodySuppressed,
      outcome,
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
      dedupe: completionDedupe.metadata,
      activeTask: activeTaskStatusCard,
      provenance: {
        childRunId: params.childRunId,
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        requesterSessionKey: targetRequesterSessionKey,
        taskLabel,
      },
    });
    const { deliveryPolicy, replyInstruction, statusCard, statusLabel } = completionDecision;
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
        statusCard,
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
    const directIdempotencyKey = buildAnnounceIdempotencyKey(
      activeTaskContract ? `v2:${completionDedupe.metadata.key}` : announceId,
    );
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
      expectsCompletionMessage: expectsCompletionMessage,
      userDeliveryEligible: deliveryPolicy.userDeliveryEligible,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      signal: params.signal,
    });
    if (delivery.delivered && subagentRegistryRuntime?.markSubagentCompletionDedupeDelivered) {
      try {
        subagentRegistryRuntime.markSubagentCompletionDedupeDelivered({
          childRunId: params.childRunId,
          childSessionKey: params.childSessionKey,
          dedupeKey: completionDedupe.metadata.key,
          activeTaskContractId: completionDedupe.metadata.activeTaskContractId ?? "unknown",
          childSessionId: completionDedupe.metadata.childSessionId ?? announceSessionId,
          taskId: completionDedupe.metadata.taskId ?? "unknown",
          resultHash: completionDedupe.metadata.resultHash,
          backgrounded: completionDedupe.backgrounded,
          ...(parentVisibleChildResult.classification.quarantineArtifact
            ? {
                quarantine: {
                  artifactId: parentVisibleChildResult.classification.quarantineArtifact.artifactId,
                  sha256: parentVisibleChildResult.classification.quarantineArtifact.payloadSha256,
                  sizeBytes: parentVisibleChildResult.classification.quarantineArtifact.byteCount,
                },
                rawArtifactReference: {
                  artifactId: parentVisibleChildResult.classification.quarantineArtifact.artifactId,
                  sha256: parentVisibleChildResult.classification.quarantineArtifact.payloadSha256,
                  sizeBytes: parentVisibleChildResult.classification.quarantineArtifact.byteCount,
                },
              }
            : {}),
          normalizedResult: {
            normalizedState: parentVisibleChildResult.classification.normalizedState,
            contractVerdict: parentVisibleChildResult.classification.contractVerdict,
            acceptanceEligible: parentVisibleChildResult.classification.acceptanceEligible,
            classificationLabels: parentVisibleChildResult.classification.classificationLabels,
            reasons: parentVisibleChildResult.classification.reasons,
          },
          ...(parentVisibleChildResult.classification.evidenceVerifier
            ? {
                evidenceVerifierDecision: {
                  decision: parentVisibleChildResult.classification.evidenceVerifier.decision,
                  acceptanceEligible:
                    parentVisibleChildResult.classification.evidenceVerifier.acceptanceEligible,
                  parentObserved:
                    parentVisibleChildResult.classification.evidenceVerifier.parentObserved,
                  ...(parentVisibleChildResult.classification.evidenceVerifier.observedBy
                    ? {
                        observedBy:
                          parentVisibleChildResult.classification.evidenceVerifier.observedBy,
                      }
                    : {}),
                  ...(parentVisibleChildResult.classification.evidenceVerifier.observedAt
                    ? {
                        observedAt:
                          parentVisibleChildResult.classification.evidenceVerifier.observedAt,
                      }
                    : {}),
                  reasons: parentVisibleChildResult.classification.evidenceVerifier.reasons,
                },
              }
            : {}),
          retryAttempt: retryAttemptRecord({
            attempt: currentRetryAttempt,
            contractVerdict: parentVisibleChildResult.classification.contractVerdict,
          }),
          ...(parentVisibleChildResult.classification.retryPolicy
            ? {
                retryPolicy: retryPolicyRecord(parentVisibleChildResult.classification.retryPolicy),
              }
            : {}),
        });
      } catch {
        // Best-effort idempotency bookkeeping; delivery already succeeded.
      }
    }
    params.onDeliveryResult?.(delivery);
    didAnnounce = delivery.delivered;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.error?.(
        `Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
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
    if (shouldDeleteChildSession) {
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
  resetCompletionDedupeForTest() {
    childCompletionDedupeCounters.clear();
  },
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
export { testing as __testing };
