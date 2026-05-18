import type { ActiveTaskStatusCardData } from "./subagent-active-task-contract.js";

export const AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION = "task_completion" as const;

export const AGENT_INTERNAL_EVENT_SOURCES = [
  "subagent",
  "cron",
  "image_generation",
  "video_generation",
  "music_generation",
] as const;

export const AGENT_INTERNAL_EVENT_STATUSES = ["ok", "timeout", "error", "unknown"] as const;

export const AGENT_TASK_COMPLETION_DELIVERY_STATES = [
  "accepted",
  "rework_required",
  "validation_required",
  "quarantined",
  "suppressed_duplicate",
] as const;

export const AGENT_TASK_COMPLETION_DELIVERY_ACTIONS = [
  "summarize_verified_result",
  "report_blocker_or_rework",
  "validate_artifact_or_retry",
  "suppress_user_visible_delivery",
] as const;

export type AgentInternalEventSource = (typeof AGENT_INTERNAL_EVENT_SOURCES)[number];
export type AgentInternalEventStatus = (typeof AGENT_INTERNAL_EVENT_STATUSES)[number];
export type AgentTaskCompletionDeliveryState =
  (typeof AGENT_TASK_COMPLETION_DELIVERY_STATES)[number];
export type AgentTaskCompletionDeliveryAction =
  (typeof AGENT_TASK_COMPLETION_DELIVERY_ACTIONS)[number];

export type AgentTaskCompletionQuarantineMetadata = {
  artifactId?: string;
  sha256: string;
  payloadSha256?: string;
  payloadHash?: string;
  sizeBytes: number;
  byteCount?: number;
  storedSizeBytes?: number;
  source?: string;
  capturedAt?: string;
  truncated?: boolean;
  redacted?: boolean;
  reason?: string;
  storageStatus?: string;
  payloadStored?: boolean;
};

export type AgentTaskCompletionRawOpenWorkflowMetadata = {
  available: boolean;
  requiredAction: "open_raw_quarantine_artifact";
  localOperatorActionRequired: true;
  warning: string;
  artifactId: string;
  payloadHash: string;
  byteCount: number;
  confirmation: {
    required: true;
    artifactId: string;
    payloadHash: string;
  };
  authorization: {
    required: true;
    scope: "local_operator";
    status: "not_requested" | "denied" | "authorized";
  };
  audit: {
    event: "subagent.raw_artifact.open_requested";
    mode: "metadata_only";
  };
  viewer: {
    isolation: "outside_ordinary_chat_model_context_compaction";
    defaultPreview: false;
    snippets: false;
    renderedPayload: false;
    rawDerivedFilename: false;
  };
  redactionScan: {
    scanned: true;
    redacted: boolean;
    flags: string[];
    rawSnippetStored: false;
  };
};

export type AgentTaskCompletionDebugRefs = {
  artifactId?: string;
  payloadHash?: string;
  resultHash?: string;
  byteCount?: number;
};

export type AgentTaskCompletionPresentationMetadata = {
  mode: "status_card";
  ordinaryChatBubble: "suppressed" | "allowed_verified_summary";
  collapsedByDefault: boolean;
  severity: "success" | "warning" | "error" | "muted";
  labels: string[];
  copyableDebugRefs?: AgentTaskCompletionDebugRefs;
};

export type AgentTaskCompletionDashboardMetadata = {
  semanticStatus: "success" | "warning" | "error" | "muted";
  label: string;
  normalizedState: string;
  acceptanceEligible: boolean;
  notSuccessUnlessVerified: true;
  labels: string[];
};

export type AgentTaskCompletionDedupeMetadata = {
  key: string;
  resultHash: string;
  seenCount: number;
  deliveredCount?: number;
  duplicateCount: number;
  suppressedCount?: number;
  backgroundedCount?: number;
  duplicate: boolean;
  parentEventSuppressed: boolean;
  activeTaskContractId?: string;
  childRunId?: string;
  childSessionId?: string;
  taskId?: string;
};

export type AgentTaskCompletionProvenanceMetadata = {
  childRunId?: string;
  childSessionKey?: string;
  childSessionId?: string;
  requesterSessionKey?: string;
  targetRequesterSessionKey?: string;
  sourceTool?: string;
  taskLabel?: string;
};

export type AgentTaskCompletionArtifactMetadata = {
  artifactId: string;
  sha256?: string;
  sizeBytes?: number;
  status?: string;
};

export type AgentTaskCompletionLogMetadata = {
  logId: string;
  sha256?: string;
  sizeBytes?: number;
  status?: string;
};

export type AgentTaskCompletionEvidenceVerifierMetadata = {
  decision: string;
  acceptanceEligible: boolean;
  parentObserved: boolean;
  observedBy?: string;
  observedAt?: string;
  reasons: string[];
  verifiedCommands?: Array<{ commandId?: string; runId?: string; status: string }>;
  verifiedArtifacts?: AgentTaskCompletionArtifactMetadata[];
  verifiedLogs?: AgentTaskCompletionLogMetadata[];
};

export type AgentTaskCompletionRetryPolicyMetadata = {
  verdict: string;
  retryAllowed: boolean;
  directVerificationRequired: boolean;
  nextMechanismKey?: string;
  nextAttemptFingerprint?: string;
  sameMechanismMalformedRetries?: number;
  sameAttemptFingerprintMalformedRetries?: number;
  acceptedMechanismChanges?: string[];
  changedProfileOrPrompt?: boolean;
  reasons: string[];
};

export type AgentTaskCompletionStatusCard = {
  kind: "subagent_completion_status";
  schemaVersion?: number;
  deliveryState: AgentTaskCompletionDeliveryState;
  action: AgentTaskCompletionDeliveryAction;
  normalizedState?: string;
  classificationLabels?: string[];
  transportOutcome: string;
  contractVerdict: string;
  acceptanceEligible: boolean;
  payloadHash?: string;
  byteCount?: number;
  schemaValid?: boolean;
  notAcceptanceEvidence?: boolean;
  verifierDecision?: "VERIFIED_PASS" | "EVIDENCE_UNVERIFIED" | string;
  evidenceParentObserved?: boolean;
  evidenceObservedBy?: string;
  evidenceReasons?: string[];
  labels?: string[];
  presentation?: AgentTaskCompletionPresentationMetadata;
  dashboard?: AgentTaskCompletionDashboardMetadata;
  debugRefs?: AgentTaskCompletionDebugRefs;
  reasons: string[];
  quarantine?: AgentTaskCompletionQuarantineMetadata;
  rawOpen?: AgentTaskCompletionRawOpenWorkflowMetadata;
  verifiedArtifacts?: AgentTaskCompletionArtifactMetadata[];
  evidenceVerifier?: AgentTaskCompletionEvidenceVerifierMetadata;
  retryPolicy?: AgentTaskCompletionRetryPolicyMetadata;
  rawBodySuppressed: boolean;
  userVisibleSuppressed?: boolean;
  userVisibleSuppressedReason?: string;
  dedupe?: AgentTaskCompletionDedupeMetadata;
  activeTask?: ActiveTaskStatusCardData;
  provenance?: AgentTaskCompletionProvenanceMetadata;
};
