import type { AgentTaskCompletionStatusCard } from "./internal-event-contract.js";
import {
  CHILD_RESULT_SCHEMA_VERSION,
  classifyChildResultContract,
  sha256Text,
  type ChildResultClassification,
  type ChildResultClassificationLabel,
  type ChildResultClassificationParams,
  type ChildResultContractVerdict,
  type ChildResultNormalizedState,
} from "./subagent-child-result-contract.js";

export const CHILD_RESULT_WAVE7_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const CHILD_RESULT_SHADOW_VERIFIER_VERSION = "wave7-shadow-verifier-v1" as const;

export const CHILD_RESULT_ROLLOUT_STAGES = [
  {
    stage: 0,
    key: "stage0_classify_only_shadow",
    description: "Classify-only shadow mode; telemetry is diagnostic and non-gating.",
  },
  {
    stage: 1,
    key: "stage1_replay_and_fixtures",
    description: "Replay historical sessions plus golden/adversarial fixtures before opt-in.",
  },
  {
    stage: 2,
    key: "stage2_opt_in_low_risk",
    description: "Opt-in low-risk workflows after replay and threshold gates pass.",
  },
  {
    stage: 3,
    key: "stage3_enforce_high_risk",
    description: "Gate merge, destructive, and external-action workflows.",
  },
  {
    stage: 4,
    key: "stage4_default_on",
    description: "Default-on after stable metrics, compatibility sign-off, and rollback drill.",
  },
] as const;

export type ChildResultRolloutStage = (typeof CHILD_RESULT_ROLLOUT_STAGES)[number]["stage"];
type ChildResultRolloutStageLike = ChildResultRolloutStage | (number & {});
type ChildResultContractVerdictLike = ChildResultContractVerdict | (string & {});
export type ChildResultSafetyProofStatus =
  | "shadow_metrics_only_not_proof"
  | "replay_fixture_gates_missing"
  | "replay_fixture_gates_satisfied";

export type ChildResultRateDimensions = {
  workerMode?: string;
  issueTaskType?: string;
  agentProfile?: string;
  taskLabel?: string;
  outputClass?: string;
  promptContextTokenSize?: number;
  childOutputSizeBytes?: number;
  fileCountRead?: number;
  fileBytesRead?: number;
  fileCountTouched?: number;
  fileBytesTouched?: number;
  logBytes?: number;
  retryCount?: number;
  sourceHeavy?: boolean;
  testHeavy?: boolean;
  verdictArtifactRequired?: boolean;
};

export type ChildResultTelemetryDimensions = {
  workerMode: string;
  issueTaskType: string;
  issueTaskTypeHash?: string;
  agentProfile: string;
  taskLabelHash?: string;
  outputClass: string;
  promptContextTokenSize?: number;
  childOutputSizeBytes?: number;
  fileCountRead?: number;
  fileBytesRead?: number;
  fileCountTouched?: number;
  fileBytesTouched?: number;
  logBytes?: number;
  retryCount?: number;
  sourceHeavy: boolean;
  testHeavy: boolean;
  verdictArtifactRequired: boolean;
};

export type ChildResultTelemetryCounters = {
  malformedOutputs: number;
  downgradedPasses: number;
  evidenceVerificationFailures: number;
  schemaVersions: Record<string, number>;
  quarantineClasses: Record<string, number>;
  duplicateSuppressions: number;
  profileMismatchBlocks: number;
};

export type ChildResultRolloutFlags = {
  stage?: ChildResultRolloutStageLike;
  classifyOnlyShadow?: boolean;
  acceptanceEnforcement?: boolean;
  uiRendering?: boolean;
  emergencyRawOpen?: boolean;
  rollbackAcceptanceEnforcement?: boolean;
  quarantineEnabled?: boolean;
  compactionSanitationEnabled?: boolean;
  rawOutputExclusionEnabled?: boolean;
};

export type ChildResultRolloutMode = {
  stage: ChildResultRolloutStage;
  stageKey: string;
  classifyOnlyShadow: boolean;
  acceptanceEnforcement: boolean;
  uiRendering: boolean;
  emergencyRawOpen: "disabled" | "isolated_raw_viewer_only";
  enforcementDisposition: "none" | "shadow_only" | "enforce" | "DIRECT_VERIFICATION_REQUIRED";
  quarantineRequired: true;
  compactionSanitationRequired: true;
  rawOutputExclusionRequired: true;
  rawChildOutputParentContext: "excluded";
  rollbackFailClosed: boolean;
  reasons: string[];
};

export type ChildResultTelemetryEvent = {
  kind: "subagent_child_result.telemetry";
  schemaVersion: typeof CHILD_RESULT_WAVE7_TELEMETRY_SCHEMA_VERSION;
  childResultSchemaVersion: typeof CHILD_RESULT_SCHEMA_VERSION;
  verifierVersion: typeof CHILD_RESULT_SHADOW_VERIFIER_VERSION;
  emittedAt: string;
  mode: "shadow" | "enforced" | "replay";
  safetyProofStatus: ChildResultSafetyProofStatus;
  displayableAsSafetyProof: boolean;
  counters: ChildResultTelemetryCounters;
  dimensions: ChildResultTelemetryDimensions;
  classification: {
    normalizedState: ChildResultNormalizedState;
    contractVerdict: ChildResultContractVerdictLike;
    acceptanceEligible: boolean;
    classificationLabels: ChildResultClassificationLabel[];
    transportOutcome: string;
    verifierDecision?: string;
    evidenceParentObserved?: boolean;
    reasonCodes: string[];
  };
  output: {
    sha256?: string;
    byteCount: number;
  };
  quarantine?: {
    artifactId: string;
    payloadSha256: string;
    byteCount: number;
    storageStatus: string;
    payloadStored: boolean;
    classes: string[];
  };
  duplicate?: {
    suppressed: boolean;
    keyHash?: string;
  };
  rollout: ChildResultRolloutMode;
};

export type ChildResultShadowVerification = {
  mode: "shadow";
  verifierVersion: typeof CHILD_RESULT_SHADOW_VERIFIER_VERSION;
  normalizedState: ChildResultNormalizedState;
  wouldAccept: boolean;
  gatingDecision: "not_applied_shadow_mode";
  existingWorkflowGateUnchanged: true;
  classification: ChildResultClassification;
  telemetryEvent: ChildResultTelemetryEvent;
};

export type ChildResultReplayExpectedOutcome = {
  normalizedState: ChildResultNormalizedState;
  contractVerdict?: string;
  acceptanceEligible?: boolean;
  classificationLabels?: ChildResultClassificationLabel[];
  dashboardSemanticStatus?: ChildResultDashboardSemanticStatus;
};

export type ChildResultReplayCase = {
  name: string;
  group:
    | "polluted_sessions"
    | "golden_fixtures"
    | "adversarial_fixtures"
    | "clean_prose_only_subagents"
    | "read_only_auditors"
    | "timeout_cancelled_children"
    | "cron_background_tasks"
    | "direct_queued_announcements"
    | "dashboard_session_history_views"
    | "restart_resume_cases";
  description?: string;
  rawText?: string;
  classificationParams?: ChildResultClassificationParams;
  rateDimensions?: ChildResultRateDimensions;
  expected: ChildResultReplayExpectedOutcome;
};

export type ChildResultReplayCaseResult = {
  name: string;
  group: ChildResultReplayCase["group"];
  expected: ChildResultReplayExpectedOutcome;
  actual: {
    normalizedState: ChildResultNormalizedState;
    contractVerdict: string;
    acceptanceEligible: boolean;
    classificationLabels: ChildResultClassificationLabel[];
    dashboardSemanticStatus: ChildResultDashboardSemanticStatus;
  };
  inputHash: string;
  inputByteCount: number;
  passed: boolean;
  mismatches: string[];
  telemetryEvent: ChildResultTelemetryEvent;
};

export type ChildResultReplayCorpusReport = {
  schemaVersion: typeof CHILD_RESULT_WAVE7_TELEMETRY_SCHEMA_VERSION;
  verifierVersion: typeof CHILD_RESULT_SHADOW_VERIFIER_VERSION;
  total: number;
  passed: number;
  failed: number;
  safetyProofStatus: ChildResultSafetyProofStatus;
  displayableAsSafetyProof: boolean;
  groups: Record<string, { total: number; passed: number; failed: number }>;
  results: ChildResultReplayCaseResult[];
};

export type ChildResultStageAdvancementEvidence = {
  targetStage: ChildResultRolloutStageLike;
  rawBodyLeakCount: number;
  schemaValidPassAcceptedWithoutEvidenceCount: number;
  goldenAdversarialFixturePassRate: number;
  compatibilityRegressionCount: number;
  replayCorpusPassed: boolean;
  shadowBaselineCollected: boolean;
  rateThresholdsApproved: boolean;
  downgradedPassRateThreshold?: number;
  malformedClassificationRateThreshold?: number;
  quarantineGrowthRateThreshold?: number;
  falsePositiveUnverifiedMalformedRateThreshold?: number;
};

export type ChildResultStageAdvancementDecision = {
  targetStage: ChildResultRolloutStage;
  canAdvance: boolean;
  thresholdsDeclared: boolean;
  thresholdsSatisfied: boolean;
  blockers: string[];
  declaredThresholds: {
    rawBodyLeakCount: 0;
    schemaValidPassAcceptedWithoutEvidenceCount: 0;
    goldenAdversarialFixturePassRate: 1;
    compatibilityRegressionCount: 0;
    rateThresholdsApproved: true;
  };
};

export type ChildResultDashboardSemanticStatus = "success" | "warning" | "error" | "muted";

export type ChildResultDashboardStatus = {
  semanticStatus: ChildResultDashboardSemanticStatus;
  label: string;
  normalizedState: string;
  acceptanceEligible: boolean;
  notSuccessUnlessVerified: true;
  labels: string[];
};

export const CHILD_RESULT_COMPATIBILITY_MATRIX = [
  {
    consumer: "legacy_prose_only_agents",
    oldBehavior: "Plain prose or plaintext PASS could be treated as completion text.",
    newNormalizedState: "UNVERIFIED_OR_MALFORMED",
    rendering: "Validation-required status; never green unless VERIFIED_PASS.",
    migration: "Write strict JSON verdict artifacts plus parent/runtime evidence.",
    failClosedFallback: "DIRECT_VERIFICATION_REQUIRED",
  },
  {
    consumer: "cron_background_flows",
    oldBehavior: "Cron output could be announced directly after run completion.",
    newNormalizedState: "UNVERIFIED_UNTIL_EVIDENCE_VERIFIED",
    rendering: "Internal status card, ordinary chat suppressed when not verified.",
    migration: "Attach run-scoped evidence, logs, and stale-process sweep metadata.",
    failClosedFallback: "DIRECT_VERIFICATION_REQUIRED",
  },
  {
    consumer: "direct_announcements",
    oldBehavior: "Direct child completion text could wake the requester.",
    newNormalizedState: "METADATA_ONLY_STATUS_CARD",
    rendering: "Verified summary or validation-required card, raw body excluded.",
    migration: "Use normalized status-card metadata and dedupe keys.",
    failClosedFallback: "RAW_OUTPUT_EXCLUDED",
  },
  {
    consumer: "queued_announcements",
    oldBehavior: "Queued delivery could replay captured child output later.",
    newNormalizedState: "METADATA_ONLY_STATUS_CARD",
    rendering: "Queued event carries hashes, labels, and state only.",
    migration: "Persist normalized metadata separately from raw quarantine artifacts.",
    failClosedFallback: "RAW_OUTPUT_EXCLUDED",
  },
  {
    consumer: "dashboards",
    oldBehavior: "PASS-looking child text could appear as success.",
    newNormalizedState: "UNVERIFIED_DISTINCT_FROM_SUCCESS",
    rendering: "UNVERIFIED is warning; only VERIFIED_PASS is success.",
    migration: "Render semantic state from normalizedState + acceptanceEligible.",
    failClosedFallback: "VALIDATION_REQUIRED",
  },
  {
    consumer: "session_history_search_export",
    oldBehavior: "Historical child bodies could be replayed, searched, or exported as chat.",
    newNormalizedState: "SANITIZED_METADATA_ONLY",
    rendering: "Search/export shows state, labels, hashes, sizes, and opaque IDs only.",
    migration: "Run sanitizer before replay/history/search/export views.",
    failClosedFallback: "RAW_OUTPUT_EXCLUDED",
  },
  {
    consumer: "restart_resume",
    oldBehavior: "Cached child PASS could survive resume without revalidation.",
    newNormalizedState: "REVALIDATE_OR_UNVERIFIED",
    rendering: "Resume downgrades stale or missing evidence to UNVERIFIED.",
    migration: "Persist evidence verifier version and revalidate on resume.",
    failClosedFallback: "DIRECT_VERIFICATION_REQUIRED",
  },
  {
    consumer: "read_only_auditors",
    oldBehavior: "Auditor prose could be interpreted as review approval.",
    newNormalizedState: "UNVERIFIED_UNTIL_PARENT_EVIDENCE",
    rendering: "Advisory review text is not acceptance evidence.",
    migration: "Auditors cite artifacts; parent/runtime verifies independently.",
    failClosedFallback: "DIRECT_VERIFICATION_REQUIRED",
  },
] as const;

const TELEMETRY_SAFE_LABEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TELEMETRY_SAFE_REASON_PREFIX_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LOCAL_PATH_RE = /(^|[\s"'`=])(?:\/(?:tmp|var|home|root|Users)\/|[A-Za-z]:\\)[^\s"'`]+/;
const RAW_BODY_MARKER_RE =
  /BEGIN_UNTRUSTED_CHILD_RESULT|END_UNTRUSTED_CHILD_RESULT|diff --git|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:export\s+function|class\s+\w+|console\.log)\b/;
const SENSITIVE_METADATA_KEY_RE =
  /^(?:raw(?:Text|Body|Input|Payload|Path)?|body|snippet|sample(?:dBody)?|parseFailureInput|content|message|text)$/i;
const ALLOWED_PROFILE_LABELS = new Set(["default", "read-only", "image-only", "unknown"]);

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function hashString(value: string): string {
  return sha256Text(value).slice(0, 32);
}

function metadataLabel(value: unknown, fallback: string): { label: string; hash?: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { label: fallback };
  }
  const trimmed = value.trim();
  if (TELEMETRY_SAFE_LABEL_RE.test(trimmed) && !LOCAL_PATH_RE.test(trimmed)) {
    return { label: trimmed };
  }
  return { label: "opaque", hash: hashString(trimmed) };
}

function metadataProfile(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ALLOWED_PROFILE_LABELS.has(normalized) ? normalized : "unknown";
}

function metadataReasonCode(value: string): string {
  const trimmed = value.trim();
  if (
    TELEMETRY_SAFE_LABEL_RE.test(trimmed) &&
    !LOCAL_PATH_RE.test(trimmed) &&
    !RAW_BODY_MARKER_RE.test(trimmed)
  ) {
    return trimmed;
  }
  const prefix = trimmed.split(/[:=\s]/, 1)[0];
  const safePrefix = TELEMETRY_SAFE_REASON_PREFIX_RE.test(prefix) ? prefix : "opaque_reason";
  return `${safePrefix}:opaque:${hashString(trimmed)}`;
}

function incrementCounter(map: Record<string, number>, key: string | undefined): void {
  if (!key) {
    return;
  }
  map[key] = (map[key] ?? 0) + 1;
}

function normalizedRateDimensions(
  dimensions: ChildResultRateDimensions | undefined,
  classification: ChildResultClassification,
  rawText?: string,
): ChildResultTelemetryDimensions {
  const issueTaskType = metadataLabel(dimensions?.issueTaskType, "unknown");
  const workerMode = metadataLabel(dimensions?.workerMode, "unknown").label;
  const outputClass = metadataLabel(
    dimensions?.outputClass ?? classification.normalizedState,
    classification.normalizedState,
  ).label;
  const taskLabel =
    typeof dimensions?.taskLabel === "string" && dimensions.taskLabel.trim()
      ? dimensions.taskLabel.trim()
      : undefined;
  const childOutputSizeBytes =
    finiteNonNegativeInteger(dimensions?.childOutputSizeBytes) ??
    (rawText !== undefined ? Buffer.byteLength(rawText, "utf8") : undefined) ??
    classification.quarantineArtifact?.byteCount;
  return {
    workerMode,
    issueTaskType: issueTaskType.label,
    ...(issueTaskType.hash ? { issueTaskTypeHash: issueTaskType.hash } : {}),
    agentProfile: metadataProfile(dimensions?.agentProfile),
    ...(taskLabel ? { taskLabelHash: hashString(taskLabel) } : {}),
    outputClass,
    ...(finiteNonNegativeInteger(dimensions?.promptContextTokenSize) !== undefined
      ? { promptContextTokenSize: finiteNonNegativeInteger(dimensions?.promptContextTokenSize) }
      : {}),
    ...(childOutputSizeBytes !== undefined ? { childOutputSizeBytes } : {}),
    ...(finiteNonNegativeInteger(dimensions?.fileCountRead) !== undefined
      ? { fileCountRead: finiteNonNegativeInteger(dimensions?.fileCountRead) }
      : {}),
    ...(finiteNonNegativeInteger(dimensions?.fileBytesRead) !== undefined
      ? { fileBytesRead: finiteNonNegativeInteger(dimensions?.fileBytesRead) }
      : {}),
    ...(finiteNonNegativeInteger(dimensions?.fileCountTouched) !== undefined
      ? { fileCountTouched: finiteNonNegativeInteger(dimensions?.fileCountTouched) }
      : {}),
    ...(finiteNonNegativeInteger(dimensions?.fileBytesTouched) !== undefined
      ? { fileBytesTouched: finiteNonNegativeInteger(dimensions?.fileBytesTouched) }
      : {}),
    ...(finiteNonNegativeInteger(dimensions?.logBytes) !== undefined
      ? { logBytes: finiteNonNegativeInteger(dimensions?.logBytes) }
      : {}),
    ...(finiteNonNegativeInteger(dimensions?.retryCount) !== undefined
      ? { retryCount: finiteNonNegativeInteger(dimensions?.retryCount) }
      : {}),
    sourceHeavy: dimensions?.sourceHeavy === true,
    testHeavy: dimensions?.testHeavy === true,
    verdictArtifactRequired: dimensions?.verdictArtifactRequired === true,
  };
}

function emptyCounters(): ChildResultTelemetryCounters {
  return {
    malformedOutputs: 0,
    downgradedPasses: 0,
    evidenceVerificationFailures: 0,
    schemaVersions: {},
    quarantineClasses: {},
    duplicateSuppressions: 0,
    profileMismatchBlocks: 0,
  };
}

function classificationLooksLikeDowngradedPass(classification: ChildResultClassification): boolean {
  return (
    !classification.acceptanceEligible &&
    classification.normalizedState === "UNVERIFIED" &&
    (classification.parsedReport?.classificationLabels.includes("SCHEMA_VALID") === true ||
      classification.classificationLabels.includes("SCHEMA_VALID"))
  );
}

function classificationLooksLikeEvidenceFailure(
  classification: ChildResultClassification,
): boolean {
  return (
    classification.evidenceVerifier?.decision === "EVIDENCE_UNVERIFIED" ||
    classification.contractVerdict === "EVIDENCE_UNVERIFIED" ||
    classification.classificationLabels.includes("EVIDENCE_UNVERIFIED")
  );
}

function classificationLooksLikeProfileMismatch(
  classification: ChildResultClassification,
  explicit: boolean | undefined,
): boolean {
  return (
    explicit === true ||
    classification.reasons.some((reason) => reason.includes("BLOCKED_INFRA_PROFILE_MISMATCH")) ||
    (classification.normalizedState === "INFRA_BLOCKED" &&
      classification.classificationLabels.includes("INFRA_BLOCKED"))
  );
}

function buildCounters(params: {
  classification: ChildResultClassification;
  profileMismatchBlocked?: boolean;
}): ChildResultTelemetryCounters {
  const counters = emptyCounters();
  const { classification } = params;
  if (classification.normalizedState === "MALFORMED") {
    counters.malformedOutputs += 1;
  }
  if (classificationLooksLikeDowngradedPass(classification)) {
    counters.downgradedPasses += 1;
  }
  if (classificationLooksLikeEvidenceFailure(classification)) {
    counters.evidenceVerificationFailures += 1;
  }
  if (classification.contractVerdict === "DUPLICATE_COMPLETION") {
    counters.duplicateSuppressions += 1;
  }
  if (classificationLooksLikeProfileMismatch(classification, params.profileMismatchBlocked)) {
    counters.profileMismatchBlocks += 1;
  }
  incrementCounter(counters.schemaVersions, String(classification.schemaVersion));
  if (classification.parsedReport?.schemaVersion !== undefined) {
    incrementCounter(
      counters.schemaVersions,
      `report:${classification.parsedReport.schemaVersion}`,
    );
  }
  if (classification.quarantineArtifact) {
    for (const label of classification.quarantineArtifact.classifications) {
      incrementCounter(counters.quarantineClasses, label);
    }
  }
  return counters;
}

function normalizeRolloutStage(stage: number | undefined): ChildResultRolloutStage {
  if (stage === 1 || stage === 2 || stage === 3 || stage === 4) {
    return stage;
  }
  return 0;
}

export function resolveChildResultRolloutMode(
  flags: ChildResultRolloutFlags | undefined = {},
): ChildResultRolloutMode {
  const stage = normalizeRolloutStage(flags.stage);
  const stageInfo = CHILD_RESULT_ROLLOUT_STAGES.find((entry) => entry.stage === stage)!;
  const rollback = flags.rollbackAcceptanceEnforcement === true;
  const reasons: string[] = [];
  const classifyOnlyShadow = flags.classifyOnlyShadow ?? stage < 2;
  const acceptanceEnforcement = rollback ? false : (flags.acceptanceEnforcement ?? stage >= 2);
  const uiRendering = flags.uiRendering ?? stage >= 2;
  const quarantineEffective = flags.quarantineEnabled !== false;
  const compactionEffective = flags.compactionSanitationEnabled !== false;
  const rawExclusionEffective = flags.rawOutputExclusionEnabled !== false;

  if (rollback) {
    reasons.push("ROLLBACK_ACCEPTANCE_ENFORCEMENT_DISABLED_TO_DIRECT_VERIFICATION_REQUIRED");
  }
  if (!quarantineEffective) {
    reasons.push("QUARANTINE_UNAVAILABLE_FAIL_CLOSED");
  }
  if (!compactionEffective) {
    reasons.push("COMPACTION_SANITATION_UNAVAILABLE_FAIL_CLOSED");
  }
  if (!rawExclusionEffective) {
    reasons.push("RAW_OUTPUT_EXCLUSION_UNAVAILABLE_FAIL_CLOSED");
  }

  const rollbackFailClosed =
    rollback || !quarantineEffective || !compactionEffective || !rawExclusionEffective;
  const enforcementDisposition = rollbackFailClosed
    ? "DIRECT_VERIFICATION_REQUIRED"
    : acceptanceEnforcement
      ? "enforce"
      : classifyOnlyShadow
        ? "shadow_only"
        : "none";

  return {
    stage,
    stageKey: stageInfo.key,
    classifyOnlyShadow,
    acceptanceEnforcement,
    uiRendering,
    emergencyRawOpen: flags.emergencyRawOpen === true ? "isolated_raw_viewer_only" : "disabled",
    enforcementDisposition,
    quarantineRequired: true,
    compactionSanitationRequired: true,
    rawOutputExclusionRequired: true,
    rawChildOutputParentContext: "excluded",
    rollbackFailClosed,
    reasons,
  };
}

export function buildChildResultTelemetryEvent(params: {
  classification: ChildResultClassification;
  rawText?: string;
  mode?: ChildResultTelemetryEvent["mode"];
  emittedAt?: string;
  rateDimensions?: ChildResultRateDimensions;
  rolloutFlags?: ChildResultRolloutFlags;
  safetyProofStatus?: ChildResultSafetyProofStatus;
  duplicateKey?: string;
  profileMismatchBlocked?: boolean;
}): ChildResultTelemetryEvent {
  const rollout = resolveChildResultRolloutMode(params.rolloutFlags);
  const rawText = params.rawText;
  const outputByteCount =
    rawText !== undefined
      ? Buffer.byteLength(rawText, "utf8")
      : (params.classification.quarantineArtifact?.byteCount ??
        params.rateDimensions?.childOutputSizeBytes ??
        0);
  const safetyProofStatus = params.safetyProofStatus ?? "shadow_metrics_only_not_proof";
  return {
    kind: "subagent_child_result.telemetry",
    schemaVersion: CHILD_RESULT_WAVE7_TELEMETRY_SCHEMA_VERSION,
    childResultSchemaVersion: CHILD_RESULT_SCHEMA_VERSION,
    verifierVersion: CHILD_RESULT_SHADOW_VERIFIER_VERSION,
    emittedAt: params.emittedAt ?? new Date().toISOString(),
    mode: params.mode ?? "shadow",
    safetyProofStatus,
    displayableAsSafetyProof: safetyProofStatus === "replay_fixture_gates_satisfied",
    counters: buildCounters({
      classification: params.classification,
      profileMismatchBlocked: params.profileMismatchBlocked,
    }),
    dimensions: normalizedRateDimensions(params.rateDimensions, params.classification, rawText),
    classification: {
      normalizedState: params.classification.normalizedState,
      contractVerdict: params.classification.contractVerdict,
      acceptanceEligible: params.classification.acceptanceEligible,
      classificationLabels: params.classification.classificationLabels,
      transportOutcome: params.classification.transportOutcome,
      ...(params.classification.evidenceVerifier?.decision
        ? { verifierDecision: params.classification.evidenceVerifier.decision }
        : {}),
      ...(params.classification.evidenceVerifier
        ? { evidenceParentObserved: params.classification.evidenceVerifier.parentObserved }
        : {}),
      reasonCodes: params.classification.reasons.map(metadataReasonCode),
    },
    output: {
      ...(rawText !== undefined ? { sha256: sha256Text(rawText) } : {}),
      byteCount: outputByteCount,
    },
    ...(params.classification.quarantineArtifact
      ? {
          quarantine: {
            artifactId: params.classification.quarantineArtifact.artifactId,
            payloadSha256: params.classification.quarantineArtifact.payloadSha256,
            byteCount: params.classification.quarantineArtifact.byteCount,
            storageStatus: params.classification.quarantineArtifact.storageStatus,
            payloadStored: params.classification.quarantineArtifact.payloadStored,
            classes: params.classification.quarantineArtifact.classifications,
          },
        }
      : {}),
    ...(params.classification.contractVerdict === "DUPLICATE_COMPLETION" || params.duplicateKey
      ? {
          duplicate: {
            suppressed: params.classification.contractVerdict === "DUPLICATE_COMPLETION",
            ...(params.duplicateKey ? { keyHash: hashString(params.duplicateKey) } : {}),
          },
        }
      : {}),
    rollout,
  };
}

export function runChildResultShadowVerifier(params: {
  classificationParams: ChildResultClassificationParams;
  rateDimensions?: ChildResultRateDimensions;
  rolloutFlags?: ChildResultRolloutFlags;
  emittedAt?: string;
  safetyProofStatus?: ChildResultSafetyProofStatus;
}): ChildResultShadowVerification {
  const classification = classifyChildResultContract(params.classificationParams);
  const wouldAccept =
    classification.acceptanceEligible && classification.normalizedState === "VERIFIED_PASS";
  return {
    mode: "shadow",
    verifierVersion: CHILD_RESULT_SHADOW_VERIFIER_VERSION,
    normalizedState: classification.normalizedState,
    wouldAccept,
    gatingDecision: "not_applied_shadow_mode",
    existingWorkflowGateUnchanged: true,
    classification,
    telemetryEvent: buildChildResultTelemetryEvent({
      classification,
      rawText: params.classificationParams.rawText ?? undefined,
      mode: "shadow",
      emittedAt: params.emittedAt,
      rateDimensions: params.rateDimensions,
      rolloutFlags: { ...params.rolloutFlags, classifyOnlyShadow: true },
      safetyProofStatus: params.safetyProofStatus,
    }),
  };
}

function expectedOutcomeMismatches(
  expected: ChildResultReplayExpectedOutcome,
  classification: ChildResultClassification,
  dashboardStatus: ChildResultDashboardStatus,
): string[] {
  const mismatches: string[] = [];
  if (classification.normalizedState !== expected.normalizedState) {
    mismatches.push(`normalizedState:${classification.normalizedState}`);
  }
  if (expected.contractVerdict && classification.contractVerdict !== expected.contractVerdict) {
    mismatches.push(`contractVerdict:${classification.contractVerdict}`);
  }
  if (
    typeof expected.acceptanceEligible === "boolean" &&
    classification.acceptanceEligible !== expected.acceptanceEligible
  ) {
    mismatches.push(`acceptanceEligible:${classification.acceptanceEligible}`);
  }
  for (const label of expected.classificationLabels ?? []) {
    if (!classification.classificationLabels.includes(label)) {
      mismatches.push(`missingLabel:${label}`);
    }
  }
  if (
    expected.dashboardSemanticStatus &&
    dashboardStatus.semanticStatus !== expected.dashboardSemanticStatus
  ) {
    mismatches.push(`dashboardSemanticStatus:${dashboardStatus.semanticStatus}`);
  }
  return mismatches;
}

export function renderChildResultDashboardStatus(
  input: ChildResultClassification | AgentTaskCompletionStatusCard,
): ChildResultDashboardStatus {
  const normalizedState =
    "normalizedState" in input && input.normalizedState ? input.normalizedState : "unknown";
  const acceptanceEligible = input.acceptanceEligible;
  const labels =
    "classificationLabels" in input && Array.isArray(input.classificationLabels)
      ? input.classificationLabels.map(String)
      : [];
  if (normalizedState === "VERIFIED_PASS" && acceptanceEligible) {
    return {
      semanticStatus: "success",
      label: "VERIFIED_PASS",
      normalizedState,
      acceptanceEligible,
      notSuccessUnlessVerified: true,
      labels,
    };
  }
  if (normalizedState === "FAIL" || normalizedState === "MALFORMED") {
    return {
      semanticStatus: "error",
      label: `${normalizedState}: validation failed`,
      normalizedState,
      acceptanceEligible,
      notSuccessUnlessVerified: true,
      labels,
    };
  }
  if (normalizedState === "CANCELLED" || normalizedState === "TIMEOUT") {
    return {
      semanticStatus: "muted",
      label: `${normalizedState}: not accepted`,
      normalizedState,
      acceptanceEligible,
      notSuccessUnlessVerified: true,
      labels,
    };
  }
  return {
    semanticStatus: "warning",
    label: `${normalizedState}: validation required`,
    normalizedState,
    acceptanceEligible,
    notSuccessUnlessVerified: true,
    labels,
  };
}

export function runChildResultReplayCorpus(
  cases: readonly ChildResultReplayCase[],
  options: {
    rolloutFlags?: ChildResultRolloutFlags;
    emittedAt?: string;
  } = {},
): ChildResultReplayCorpusReport {
  const results: ChildResultReplayCaseResult[] = cases.map((testCase) => {
    const rawText = testCase.rawText ?? testCase.classificationParams?.rawText ?? "";
    const classification = classifyChildResultContract({
      ...testCase.classificationParams,
      rawText,
    });
    const dashboardStatus = renderChildResultDashboardStatus(classification);
    const mismatches = expectedOutcomeMismatches(
      testCase.expected,
      classification,
      dashboardStatus,
    );
    const passed = mismatches.length === 0;
    return {
      name: testCase.name,
      group: testCase.group,
      expected: testCase.expected,
      actual: {
        normalizedState: classification.normalizedState,
        contractVerdict: classification.contractVerdict,
        acceptanceEligible: classification.acceptanceEligible,
        classificationLabels: classification.classificationLabels,
        dashboardSemanticStatus: dashboardStatus.semanticStatus,
      },
      inputHash: sha256Text(rawText),
      inputByteCount: Buffer.byteLength(rawText, "utf8"),
      passed,
      mismatches,
      telemetryEvent: buildChildResultTelemetryEvent({
        classification,
        rawText,
        mode: "replay",
        emittedAt: options.emittedAt,
        rateDimensions: testCase.rateDimensions,
        rolloutFlags: options.rolloutFlags,
        safetyProofStatus: "replay_fixture_gates_missing",
      }),
    };
  });
  const groups: Record<string, { total: number; passed: number; failed: number }> = {};
  for (const result of results) {
    groups[result.group] ??= { total: 0, passed: 0, failed: 0 };
    groups[result.group].total += 1;
    if (result.passed) {
      groups[result.group].passed += 1;
    } else {
      groups[result.group].failed += 1;
    }
  }
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const safetyProofStatus: ChildResultSafetyProofStatus =
    results.length > 0 && failed === 0
      ? "replay_fixture_gates_satisfied"
      : "replay_fixture_gates_missing";
  return {
    schemaVersion: CHILD_RESULT_WAVE7_TELEMETRY_SCHEMA_VERSION,
    verifierVersion: CHILD_RESULT_SHADOW_VERIFIER_VERSION,
    total: results.length,
    passed,
    failed,
    safetyProofStatus,
    displayableAsSafetyProof: safetyProofStatus === "replay_fixture_gates_satisfied",
    groups,
    results: results.map((result) =>
      Object.assign({}, result, {
        telemetryEvent: Object.assign({}, result.telemetryEvent, {
          safetyProofStatus,
          displayableAsSafetyProof: safetyProofStatus === "replay_fixture_gates_satisfied",
        }),
      }),
    ),
  };
}

function rateThresholdsDeclared(evidence: ChildResultStageAdvancementEvidence): boolean {
  return (
    typeof evidence.downgradedPassRateThreshold === "number" &&
    typeof evidence.malformedClassificationRateThreshold === "number" &&
    typeof evidence.quarantineGrowthRateThreshold === "number" &&
    typeof evidence.falsePositiveUnverifiedMalformedRateThreshold === "number"
  );
}

export function evaluateChildResultStageAdvancement(
  evidence: ChildResultStageAdvancementEvidence,
): ChildResultStageAdvancementDecision {
  const targetStage = normalizeRolloutStage(evidence.targetStage);
  const blockers: string[] = [];
  const thresholdsDeclared = targetStage < 2 || rateThresholdsDeclared(evidence);

  if (targetStage >= 2) {
    if (evidence.rawBodyLeakCount !== 0) {
      blockers.push("RAW_BODY_LEAKS_MUST_BE_ZERO");
    }
    if (evidence.schemaValidPassAcceptedWithoutEvidenceCount !== 0) {
      blockers.push("SCHEMA_VALID_PASS_WITHOUT_EVIDENCE_MUST_BE_ZERO");
    }
    if (evidence.goldenAdversarialFixturePassRate !== 1) {
      blockers.push("GOLDEN_ADVERSARIAL_FIXTURES_MUST_BE_100_PERCENT");
    }
    if (evidence.compatibilityRegressionCount !== 0) {
      blockers.push("COMPATIBILITY_REGRESSIONS_MUST_BE_ZERO");
    }
    if (!evidence.replayCorpusPassed) {
      blockers.push("REPLAY_CORPUS_MUST_PASS");
    }
    if (!evidence.shadowBaselineCollected) {
      blockers.push("SHADOW_BASELINE_REQUIRED_FOR_RATE_THRESHOLDS");
    }
    if (!evidence.rateThresholdsApproved || !thresholdsDeclared) {
      blockers.push("RATE_THRESHOLDS_MUST_BE_DECLARED_FROM_SHADOW_BASELINE_AND_APPROVED");
    }
  }

  return {
    targetStage,
    canAdvance: blockers.length === 0,
    thresholdsDeclared,
    thresholdsSatisfied: blockers.length === 0,
    blockers,
    declaredThresholds: {
      rawBodyLeakCount: 0,
      schemaValidPassAcceptedWithoutEvidenceCount: 0,
      goldenAdversarialFixturePassRate: 1,
      compatibilityRegressionCount: 0,
      rateThresholdsApproved: true,
    },
  };
}

export function buildChildResultShadowSafetySummary(params: {
  telemetryEvents: readonly ChildResultTelemetryEvent[];
  replayReport?: ChildResultReplayCorpusReport;
  stageDecision?: ChildResultStageAdvancementDecision;
}): {
  status: ChildResultSafetyProofStatus;
  displayableAsSafetyProof: boolean;
  warning?: string;
  telemetryEventCount: number;
} {
  const replayPassed = params.replayReport?.safetyProofStatus === "replay_fixture_gates_satisfied";
  const thresholdsPassed = params.stageDecision?.thresholdsSatisfied === true;
  const status: ChildResultSafetyProofStatus =
    replayPassed && thresholdsPassed
      ? "replay_fixture_gates_satisfied"
      : replayPassed
        ? "replay_fixture_gates_missing"
        : "shadow_metrics_only_not_proof";
  return {
    status,
    displayableAsSafetyProof: status === "replay_fixture_gates_satisfied",
    ...(status === "replay_fixture_gates_satisfied"
      ? {}
      : {
          warning:
            "Shadow-mode metrics are diagnostic only and cannot be presented as proof of safety until replay, fixture, compatibility, and Stage 2 threshold gates pass.",
        }),
    telemetryEventCount: params.telemetryEvents.length,
  };
}

export function buildChildResultParserErrorTelemetry(params: {
  error: unknown;
  failedInput?: string;
  emittedAt?: string;
}): {
  kind: "subagent_child_result.parser_error";
  schemaVersion: typeof CHILD_RESULT_WAVE7_TELEMETRY_SCHEMA_VERSION;
  emittedAt: string;
  errorName: string;
  errorMessageHash?: string;
  failedInputSha256?: string;
  failedInputByteCount?: number;
} {
  const errorName = params.error instanceof Error ? params.error.name : typeof params.error;
  const errorMessage = params.error instanceof Error ? params.error.message : undefined;
  return {
    kind: "subagent_child_result.parser_error",
    schemaVersion: CHILD_RESULT_WAVE7_TELEMETRY_SCHEMA_VERSION,
    emittedAt: params.emittedAt ?? new Date().toISOString(),
    errorName,
    ...(errorMessage ? { errorMessageHash: hashString(errorMessage) } : {}),
    ...(typeof params.failedInput === "string"
      ? {
          failedInputSha256: sha256Text(params.failedInput),
          failedInputByteCount: Buffer.byteLength(params.failedInput, "utf8"),
        }
      : {}),
  };
}

export function assertChildResultMetadataOnly(
  value: unknown,
  forbiddenNeedles: readonly string[] = [],
): { ok: true } | { ok: false; leaks: string[] } {
  const leaks: string[] = [];
  const visit = (node: unknown, pointer: string): void => {
    if (node === null || node === undefined) {
      return;
    }
    if (typeof node === "string") {
      if (LOCAL_PATH_RE.test(node)) {
        leaks.push(`${pointer}:local_path`);
      }
      if (RAW_BODY_MARKER_RE.test(node)) {
        leaks.push(`${pointer}:raw_body_marker`);
      }
      for (const needle of forbiddenNeedles) {
        if (needle && node.includes(needle)) {
          leaks.push(`${pointer}:forbidden_needle`);
        }
      }
      return;
    }
    if (typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
      return;
    }
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (SENSITIVE_METADATA_KEY_RE.test(key)) {
        leaks.push(`${pointer}/${key}:sensitive_key`);
      }
      visit(entry, `${pointer}/${key}`);
    }
  };
  visit(value, "$");
  return leaks.length === 0 ? { ok: true } : { ok: false, leaks };
}
