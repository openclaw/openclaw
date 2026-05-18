import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type PendingFinalDeliveryPayload = {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  frozenResultText?: string | null;
  fallbackFrozenResultText?: string | null;
  wakeOnDescendantSettle?: boolean;
};

export type SubagentCompletionDedupeCounters = {
  seenCount: number;
  deliveredCount: number;
  duplicateCount: number;
  suppressedCount: number;
  backgroundedCount: number;
};

export type SubagentCompletionArtifactReference = {
  artifactId?: string;
  sha256: string;
  sizeBytes: number;
};

export type SubagentCompletionNormalizedResult = {
  normalizedState: string;
  contractVerdict: string;
  acceptanceEligible: boolean;
  classificationLabels: string[];
  reasons: string[];
};

export type SubagentCompletionEvidenceVerifierDecision = {
  decision: string;
  acceptanceEligible: boolean;
  parentObserved: boolean;
  observedBy?: string;
  observedAt?: string;
  reasons: string[];
};

export type SubagentChildResultRetryAttemptRecord = {
  contractVerdict?: string;
  mechanismKey?: string;
  mechanismChanges?: string[];
  profileKey?: string;
  promptHash?: string;
  attemptFingerprint?: string;
  recordedAt?: number;
};

export type SubagentChildResultRetryPolicyRecord = {
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

export type SubagentCompletionDedupeRecord = {
  key: string;
  activeTaskContractId: string;
  childRunId: string;
  childSessionId: string;
  taskId: string;
  resultHash: string;
  firstSeenAt: number;
  lastSeenAt: number;
  deliveredAt?: number;
  counters: SubagentCompletionDedupeCounters;
  lastSuppressedAt?: number;
  lastBackgroundedAt?: number;
  lastQuarantine?: SubagentCompletionArtifactReference;
  lastRawArtifactReference?: SubagentCompletionArtifactReference;
  lastNormalizedResult?: SubagentCompletionNormalizedResult;
  lastEvidenceVerifierDecision?: SubagentCompletionEvidenceVerifierDecision;
  lastChildResultRetryAttempt?: SubagentChildResultRetryAttemptRecord;
  lastChildResultRetryPolicy?: SubagentChildResultRetryPolicyRecord;
};

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  createdAt: number;
  startedAt?: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;
  lastAnnounceDeliveryError?: string;
  endedReason?: SubagentLifecycleEndedReason;
  pauseReason?: "sessions_yield";
  wakeOnDescendantSettle?: boolean;
  frozenResultText?: string | null;
  frozenResultCapturedAt?: number;
  fallbackFrozenResultText?: string | null;
  fallbackFrozenResultCapturedAt?: number;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Durable marker that final user delivery still needs a retry/resume pass. */
  pendingFinalDelivery?: boolean;
  pendingFinalDeliveryCreatedAt?: number;
  pendingFinalDeliveryLastAttemptAt?: number;
  pendingFinalDeliveryAttemptCount?: number;
  pendingFinalDeliveryLastError?: string | null;
  pendingFinalDeliveryPayload?: PendingFinalDeliveryPayload;
  deliverySuspendedAt?: number;
  deliverySuspendedReason?: "retry-limit" | "expiry";
  deliveryDiscardedAt?: number;
  deliveryDiscardReason?: "expired" | "pressure-pruned";
  deliveryDiscardedPayloadSummary?: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    childRunId?: string;
    endedAt?: number;
    status?: string;
    lastError?: string | null;
  };
  completionEnqueuedAt?: number;
  completionDeliveredAt?: number;
  completionAnnouncedAt?: number;
  childResultRetryAttempt?: SubagentChildResultRetryAttemptRecord;
  completionDedupe?: SubagentCompletionDedupeRecord;
  completionDedupeRecords?: Record<string, SubagentCompletionDedupeRecord>;
  lastAnnounceDropReason?: "queue_cap" | "parent_run_ended" | "sink_unavailable" | "dedupe";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
