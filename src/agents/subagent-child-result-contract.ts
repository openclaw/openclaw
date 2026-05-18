import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wrapPromptDataBlock } from "./sanitize-for-prompt.js";
import {
  ACTIVE_TASK_CONTRACT_MISSING_VERDICT,
  ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
  ACTIVE_TASK_SCHEMA_VALID_VERDICT,
  normalizeActiveTaskContract,
  type ActiveTaskArtifact,
} from "./subagent-active-task-contract.js";

export const CHILD_RESULT_SCHEMA_VALID = ACTIVE_TASK_SCHEMA_VALID_VERDICT;
export const CHILD_RESULT_MISSING_VERDICT_SCHEMA = "MISSING_VERDICT_SCHEMA" as const;
export const CHILD_RESULT_MISSING_REQUIRED_ARTIFACT = "MISSING_REQUIRED_ARTIFACT" as const;
export const CHILD_RESULT_FAILED_GATES = "FAILED_GATES" as const;
export const CHILD_RESULT_REJECTED = "REJECTED" as const;
export const CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT = "MALFORMED_RAW_SOURCE_OUTPUT" as const;
export const CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT = "MALFORMED_TOOL_LOG_OUTPUT" as const;
export const CHILD_RESULT_DUPLICATE_COMPLETION = "DUPLICATE_COMPLETION" as const;
export const CHILD_RESULT_EVIDENCE_UNVERIFIED = ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT;
export const CHILD_RESULT_TASK_CONTRACT_MISSING = ACTIVE_TASK_CONTRACT_MISSING_VERDICT;
export const CHILD_RESULT_RETRY_ALLOWED = "RETRY_ALLOWED" as const;
export const CHILD_RESULT_RETRY_POLICY_EXHAUSTED = "RETRY_POLICY_EXHAUSTED" as const;

export const CHILD_RESULT_SCHEMA_VERSION = 1 as const;
export const CHILD_RESULT_QUARANTINE_SCHEMA_VERSION = 1 as const;
export const CHILD_RESULT_DEFAULT_QUARANTINE_TTL_DAYS = 30 as const;
export const CHILD_RESULT_DEFAULT_MAX_QUARANTINE_ARTIFACT_BYTES = 1024 * 1024;
export const CHILD_RESULT_DEFAULT_MAX_QUARANTINE_STORE_BYTES = 64 * 1024 * 1024;
export const CHILD_RESULT_DEFAULT_MAX_QUARANTINE_STORE_COUNT = 2048;
export const CHILD_RESULT_QUARANTINE_ENCRYPTION_EXCEPTION =
  "Encryption at rest is not implemented in Wave 1; quarantine remains local-only, 0700/0600, non-git/sync/backup by policy until mediator accepts this threat-model exception." as const;

export const CHILD_RESULT_NORMALIZED_STATES = [
  "VERIFIED_PASS",
  "FAIL",
  "UNVERIFIED",
  "MALFORMED",
  "TIMEOUT",
  "CANCELLED",
  "INFRA_BLOCKED",
] as const;

export const CHILD_RESULT_CLASSIFICATION_LABELS = [
  "SCHEMA_VALID",
  "NO_VERDICT",
  "SCHEMA_INVALID",
  "MALFORMED_QUARANTINED",
  "UNVERIFIED",
  "EVIDENCE_UNVERIFIED",
  "NOT_ACCEPTANCE_EVIDENCE",
  "RAW_SOURCE_LIKE",
  "RAW_DIFF_LIKE",
  "RAW_LOG_LIKE",
  "RAW_GREP_LIKE",
  "PARTIAL_OUTPUT",
  "OVERSIZE_OUTPUT",
  "INTERNAL_ENVELOPE",
  "NO_OUTPUT",
  "INFRA_BLOCKED",
  "STALE_PROCESS_RISK",
  "DUPLICATE_ANNOUNCE_SUPPRESSED",
] as const;

export const CHILD_RESULT_RETRY_MECHANISM_CHANGES = [
  "narrower_scope",
  "redirected_logs",
  "capability_correct_profile",
  "pre_created_path",
  "schema_validator",
] as const;

export const CHILD_RESULT_RETRY_MALFORMED_VERDICTS = [
  CHILD_RESULT_MISSING_VERDICT_SCHEMA,
  CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
  CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT,
  CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
  CHILD_RESULT_EVIDENCE_UNVERIFIED,
  CHILD_RESULT_TASK_CONTRACT_MISSING,
] as const;

export const CHILD_RESULT_CONTRACT_VERDICTS = [
  CHILD_RESULT_SCHEMA_VALID,
  CHILD_RESULT_MISSING_VERDICT_SCHEMA,
  CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
  CHILD_RESULT_FAILED_GATES,
  CHILD_RESULT_REJECTED,
  CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT,
  CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
  CHILD_RESULT_DUPLICATE_COMPLETION,
  CHILD_RESULT_EVIDENCE_UNVERIFIED,
  CHILD_RESULT_TASK_CONTRACT_MISSING,
] as const;

export type ChildResultContractVerdict = (typeof CHILD_RESULT_CONTRACT_VERDICTS)[number];
type ChildResultContractVerdictLike = ChildResultContractVerdict | (string & {});
type ChildRunOutcomeStatus =
  | "ok"
  | "error"
  | "timeout"
  | "cancelled"
  | "canceled"
  | "unknown"
  | (string & {});
export type ChildResultRetryPolicyVerdict =
  | typeof CHILD_RESULT_RETRY_ALLOWED
  | typeof CHILD_RESULT_RETRY_POLICY_EXHAUSTED;
export type ChildResultRetryMechanismChange = (typeof CHILD_RESULT_RETRY_MECHANISM_CHANGES)[number];

export type ChildResultNormalizedState = (typeof CHILD_RESULT_NORMALIZED_STATES)[number];
export type ChildResultClassificationLabel = (typeof CHILD_RESULT_CLASSIFICATION_LABELS)[number];
export type ChildResultParserMode =
  | "strict_json"
  | "fenced_json"
  | "embedded_json"
  | "legacy_plaintext"
  | "malformed_json"
  | "no_output";

export type ChildResultTransportOutcome =
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "unknown";

export type ChildResultRawSource =
  | "assistant_output"
  | "tool_log"
  | "raw_source"
  | "artifact"
  | "unknown";

type ChildRunOutcomeLike = {
  status?: ChildRunOutcomeStatus;
  error?: string;
};

export type ChildResultRedactionSummary = {
  scanned: true;
  redacted: boolean;
  flags: string[];
  tokenLikeCount: number;
  credentialKeyCount: number;
  privateKeyLikeCount: number;
  rawSnippetStored: false;
};

export type ChildResultRetentionMetadata = {
  ttlDays: number;
  expiresAt: string;
  cleanupEligibleAt: string;
  maxStoreBytes: number;
  maxStoreCount: number;
  cleanupPolicy: "ttl_and_quota";
  operatorDeletion: "supported_by_artifact_id";
  gitExcluded: boolean;
  syncExcluded: boolean;
  backupExcludedUnlessEncrypted: boolean;
  encryptionAtRest: "not_implemented";
  encryptionException: typeof CHILD_RESULT_QUARANTINE_ENCRYPTION_EXCEPTION;
};

export type ChildResultQuarantineStorageStatus = "stored" | "metadata_only" | "unavailable";

export type ChildResultQuarantineArtifact = {
  schemaVersion: typeof CHILD_RESULT_QUARANTINE_SCHEMA_VERSION;
  artifactId: string;
  path?: string;
  metadataPath?: string;
  payloadPath?: string;
  sha256: string;
  payloadSha256: string;
  sizeBytes: number;
  byteCount: number;
  storedSizeBytes: number;
  source: ChildResultRawSource;
  capturedAt: string;
  createdAt: string;
  truncated: boolean;
  redacted: boolean;
  reason: ChildResultContractVerdictLike;
  status: ChildResultNormalizedState;
  classifications: ChildResultClassificationLabel[];
  storageStatus: ChildResultQuarantineStorageStatus;
  payloadStored: boolean;
  rawBodyIncludedInMetadata: false;
  redaction: ChildResultRedactionSummary;
  retention: ChildResultRetentionMetadata;
  childSessionKey?: string;
  childRunId?: string;
  requesterSessionKey?: string;
  taskLabel?: string;
  unavailableReason?: string;
};

export type ChildResultReportedArtifact = {
  artifactId?: string;
  path: string;
  sha256?: string;
  sizeBytes?: number;
};

export type ChildResultArtifactDebugMetadata = {
  artifactId: string;
  sha256?: string;
  sizeBytes?: number;
  status?: string;
};

export type ChildResultLogDebugMetadata = {
  logId: string;
  sha256?: string;
  sizeBytes?: number;
  status?: string;
};

export type ChildResultScopeCheck = {
  allowedChangedPaths?: string[];
  allowedSourcePaths?: string[];
};

export type ChildResultScopedGateProcess = {
  name?: string;
  status: string;
};

export type ChildResultParentRuntimeObserver = "parent_runtime" | "checker" | "mediator";
type ChildResultParentRuntimeObserverLike = ChildResultParentRuntimeObserver | (string & {});

export type ChildResultParentRuntimeFileEvidence = {
  artifactId?: string;
  logId?: string;
  path?: string;
  sha256: string;
  sizeBytes?: number;
  mtimeMs?: number;
  observedAt?: string;
  observedAtMs?: number;
  sessionId?: string;
  childRunId?: string;
  childSessionId?: string;
  childSessionKey?: string;
};

export type ChildResultParentRuntimeCommandEvidence = {
  commandId?: string;
  runId?: string;
  command?: string;
  status: string;
  exitCode?: number;
  logId?: string;
  logPath?: string;
  logSha256?: string;
  observedAt?: string;
  observedAtMs?: number;
  sessionId?: string;
  childRunId?: string;
  childSessionId?: string;
  childSessionKey?: string;
};

export type ChildResultParentRuntimeScopeEvidence = ChildResultScopeCheck & {
  allowedArtifactPaths?: string[];
  allowedArtifactRoots?: string[];
  allowedLogPaths?: string[];
  allowedLogRoots?: string[];
};

export type ChildResultParentRuntimeRepoEvidence = {
  commitId?: string;
  headCommitId?: string;
  worktreeDirty?: boolean;
  dirtyState?: "clean" | "dirty_allowed" | "dirty_unverified";
};

export type ChildResultParentRuntimeStaleProcessSweepEvidence = {
  status: string;
  noRunningProcesses?: boolean;
  logId?: string;
  logPath?: string;
  logSha256?: string;
  observedAt?: string;
  observedAtMs?: number;
  sessionId?: string;
  childRunId?: string;
  childSessionId?: string;
  childSessionKey?: string;
};

export type ChildResultParentRuntimeEvidence = {
  observedBy: ChildResultParentRuntimeObserverLike;
  observedAt?: string;
  observedAtMs?: number;
  sessionId?: string;
  childRunId?: string;
  childSessionId?: string;
  childSessionKey?: string;
  commands?: ChildResultParentRuntimeCommandEvidence[];
  artifacts?: ChildResultParentRuntimeFileEvidence[];
  logs?: ChildResultParentRuntimeFileEvidence[];
  scope?: ChildResultParentRuntimeScopeEvidence;
  repoState?: ChildResultParentRuntimeRepoEvidence;
  staleProcessSweep?: ChildResultParentRuntimeStaleProcessSweepEvidence;
};

export type ChildResultEvidenceVerifierDecision = {
  decision: "VERIFIED_PASS" | "EVIDENCE_UNVERIFIED";
  acceptanceEligible: boolean;
  parentObserved: boolean;
  observedBy?: string;
  observedAt?: string;
  reasons: string[];
  verifiedCommands?: Array<{ commandId?: string; runId?: string; status: string }>;
  verifiedArtifacts?: ChildResultArtifactDebugMetadata[];
  verifiedLogs?: ChildResultLogDebugMetadata[];
  scope?: ChildResultParentRuntimeScopeEvidence;
  repoState?: ChildResultParentRuntimeRepoEvidence;
  staleProcessSweep?: ChildResultParentRuntimeStaleProcessSweepEvidence;
};

export type ChildResultClassificationParams = {
  rawText?: string | null;
  rawSource?: ChildResultRawSource;
  outcome?: ChildRunOutcomeLike;
  activeTaskContract?: unknown;
  childTaskId?: string;
  duplicateCompletion?: boolean;
  spawnedAtMs?: number;
  expectedStubCreatedAtMs?: number;
  expectedStubCreatedAtMsByPath?: Record<string, number>;
  expectedOutputArtifacts?: ActiveTaskArtifact[];
  parentPostflightHashes?: Record<string, string>;
  parentScopeCheck?: ChildResultScopeCheck;
  scopedGateProcesses?: ChildResultScopedGateProcess[];
  parentRuntimeEvidence?: ChildResultParentRuntimeEvidence;
  maxVerifiedArtifactBytes?: number;
  maxQuarantineBodyChars?: number;
  maxQuarantineArtifactBytes?: number;
  maxQuarantineStoreBytes?: number;
  maxQuarantineStoreCount?: number;
  quarantineTtlDays?: number;
  quarantineRoot?: string;
  allowUnsafeQuarantineRoot?: boolean;
  childSessionKey?: string;
  childSessionId?: string;
  childRunId?: string;
  requesterSessionKey?: string;
  taskLabel?: string;
  requireActiveTaskContract?: boolean;
  previousRetryAttempts?: ChildResultRetryAttempt[];
  currentRetryAttempt?: Pick<
    ChildResultRetryAttempt,
    "mechanismKey" | "mechanismChanges" | "profileKey" | "promptHash" | "prompt"
  >;
  nextRetryAttempt?: Pick<
    ChildResultRetryAttempt,
    "mechanismKey" | "mechanismChanges" | "profileKey" | "promptHash" | "prompt"
  >;
};

export type ChildResultRetryAttempt = {
  contractVerdict?: ChildResultContractVerdictLike;
  mechanismKey?: string;
  mechanismChanges?: string[];
  profileKey?: string;
  promptHash?: string;
  prompt?: string;
};

export type ChildResultRetryPolicyDecision = {
  verdict: ChildResultRetryPolicyVerdict;
  retryAllowed: boolean;
  nextMechanismKey: string;
  nextAttemptFingerprint: string;
  sameMechanismMalformedRetries: number;
  sameAttemptFingerprintMalformedRetries: number;
  acceptedMechanismChanges: ChildResultRetryMechanismChange[];
  requiredMechanismChanges: readonly ChildResultRetryMechanismChange[];
  changedProfileOrPrompt: boolean;
  directVerificationRequired: boolean;
  reasons: string[];
};

export type ParsedChildResultReport = {
  schemaVersion?: number;
  parserMode: ChildResultParserMode;
  strictJson: boolean;
  schemaValid: boolean;
  normalizedState: ChildResultNormalizedState;
  classificationLabels: ChildResultClassificationLabel[];
  verdict?: string;
  contractVerdict?: string;
  taskId?: string;
  activeTaskContractId?: string;
  failures?: number;
  outputArtifactPaths: string[];
  outputArtifacts: ChildResultReportedArtifact[];
  changedPaths: string[];
  sourcePaths: string[];
  commandsRun: Array<Record<string, unknown>>;
  raw?: never;
};

export type ChildResultSanitizedMetadata = {
  schemaVersion: typeof CHILD_RESULT_SCHEMA_VERSION;
  normalizedState: ChildResultNormalizedState;
  contractVerdict: ChildResultContractVerdict;
  acceptanceEligible: boolean;
  classificationLabels: ChildResultClassificationLabel[];
  reasons: string[];
  transportOutcome: ChildResultTransportOutcome;
  activeTaskContractId?: string;
  currentTaskOutput?: boolean;
  backgrounded?: boolean;
  quarantine?: {
    artifactId: string;
    payloadSha256: string;
    byteCount: number;
    source: ChildResultRawSource;
    createdAt: string;
    storageStatus: ChildResultQuarantineStorageStatus;
    payloadStored: boolean;
    redaction: ChildResultRedactionSummary;
    retention: ChildResultRetentionMetadata;
    unavailableReason?: string;
  };
  verifiedArtifacts?: ChildResultArtifactDebugMetadata[];
  evidenceVerifier?: ChildResultEvidenceVerifierDecision;
  retryPolicy?: ChildResultRetryPolicyDecision;
};

export type ChildResultClassification = {
  schemaVersion: typeof CHILD_RESULT_SCHEMA_VERSION;
  normalizedState: ChildResultNormalizedState;
  classificationLabels: ChildResultClassificationLabel[];
  transportOutcome: ChildResultTransportOutcome;
  contractVerdict: ChildResultContractVerdict;
  acceptanceEligible: boolean;
  reasons: string[];
  safeSummary: string;
  sanitizedMetadata: ChildResultSanitizedMetadata;
  activeTaskContractId?: string;
  currentTaskOutput?: boolean;
  backgrounded?: boolean;
  parsedReport?: ParsedChildResultReport;
  quarantineArtifact?: ChildResultQuarantineArtifact;
  verifiedArtifacts?: ChildResultReportedArtifact[];
  evidenceVerifier?: ChildResultEvidenceVerifierDecision;
  retryPolicy?: ChildResultRetryPolicyDecision;
};

const DEFAULT_MAX_PARENT_SUMMARY_CHARS = 1_200;
const DEFAULT_MAX_VERIFIED_ARTIFACT_BYTES = 512 * 1024;
const POSIX_PRIVATE_DIR_MODE = 0o700;
const POSIX_PRIVATE_FILE_MODE = 0o600;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const NULL_BYTE_RE = new RegExp(String.fromCharCode(0), "g");
const HASH_RE = /^[a-f0-9]{64}$/i;
const RUNNING_GATE_STATUSES = new Set(["active", "in_progress", "pending", "running", "started"]);
const CLEAN_GATE_EVIDENCE_STATUSES = new Set([
  "clean",
  "complete",
  "completed",
  "done",
  "exited",
  "finished",
  "no_matching_processes",
  "ok",
  "pass",
  "passed",
  "success",
  "succeeded",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueClassificationLabels(
  values: Array<ChildResultClassificationLabel | undefined | false>,
): ChildResultClassificationLabel[] {
  const allowed = new Set<string>(CHILD_RESULT_CLASSIFICATION_LABELS);
  return uniqueStrings(
    values.filter(
      (value): value is ChildResultClassificationLabel =>
        typeof value === "string" && allowed.has(value),
    ),
  ) as ChildResultClassificationLabel[];
}

function labelForContractVerdict(
  verdict: ChildResultContractVerdict,
): ChildResultClassificationLabel | undefined {
  switch (verdict) {
    case CHILD_RESULT_SCHEMA_VALID:
      return "SCHEMA_VALID";
    case CHILD_RESULT_EVIDENCE_UNVERIFIED:
    case CHILD_RESULT_MISSING_REQUIRED_ARTIFACT:
    case CHILD_RESULT_TASK_CONTRACT_MISSING:
      return "EVIDENCE_UNVERIFIED";
    case CHILD_RESULT_MISSING_VERDICT_SCHEMA:
      return "NO_VERDICT";
    case CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT:
      return "RAW_SOURCE_LIKE";
    case CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT:
      return "RAW_LOG_LIKE";
    case CHILD_RESULT_DUPLICATE_COMPLETION:
      return "DUPLICATE_ANNOUNCE_SUPPRESSED";
    default:
      return undefined;
  }
}

function classificationLabelsForReasons(
  reasons: readonly string[],
): ChildResultClassificationLabel[] {
  const labels: ChildResultClassificationLabel[] = [];
  if (reasons.some((reason) => /^STALE_PROCESS_|^SCOPED_GATE_PROCESS_STILL_RUNNING/.test(reason))) {
    labels.push("STALE_PROCESS_RISK");
  }
  return labels;
}

function normalizedStateForContractVerdict(params: {
  verdict: ChildResultContractVerdict;
  acceptanceEligible: boolean;
  transportOutcome: ChildResultTransportOutcome;
  labels?: ChildResultClassificationLabel[];
}): ChildResultNormalizedState {
  if (params.transportOutcome === "timeout") {
    return "TIMEOUT";
  }
  if (params.transportOutcome === "cancelled") {
    return "CANCELLED";
  }
  if (params.verdict === CHILD_RESULT_DUPLICATE_COMPLETION) {
    return "CANCELLED";
  }
  if (params.verdict === CHILD_RESULT_SCHEMA_VALID && params.acceptanceEligible) {
    return "VERIFIED_PASS";
  }
  if (params.verdict === CHILD_RESULT_FAILED_GATES || params.verdict === CHILD_RESULT_REJECTED) {
    return "FAIL";
  }
  if (
    params.verdict === CHILD_RESULT_MISSING_VERDICT_SCHEMA ||
    params.verdict === CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT ||
    params.verdict === CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT
  ) {
    return "MALFORMED";
  }
  if (params.labels?.includes("INFRA_BLOCKED")) {
    return "INFRA_BLOCKED";
  }
  return "UNVERIFIED";
}

function normalizeHash(value: unknown): string | undefined {
  const hash = normalizeNonEmptyString(value);
  return hash && HASH_RE.test(hash) ? hash.toLowerCase() : undefined;
}

export function sha256Text(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function evidenceDebugId(prefix: "artifact" | "log", stableSource: string): string {
  return `${prefix}_${sha256Text(stableSource).slice(0, 16)}`;
}

function sanitizeVerifiedArtifactMetadata(
  artifact: ChildResultReportedArtifact | ChildResultArtifactDebugMetadata,
  status = "verified",
): ChildResultArtifactDebugMetadata {
  const sizeBytes = finiteEvidenceNumber(artifact.sizeBytes);
  const stableSource =
    normalizeNonEmptyString(artifact.artifactId) ??
    ("path" in artifact ? normalizeNonEmptyString(artifact.path) : undefined) ??
    "unknown";
  return {
    artifactId:
      normalizeNonEmptyString(artifact.artifactId) ?? evidenceDebugId("artifact", stableSource),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    status: ("status" in artifact ? artifact.status : undefined) ?? status,
  };
}

function sanitizeVerifiedLogMetadata(log: {
  logId?: string;
  path?: string;
  sha256?: string;
  sizeBytes?: number;
  status?: string;
}): ChildResultLogDebugMetadata {
  const stableSource =
    normalizeNonEmptyString(log.logId) ?? normalizeNonEmptyString(log.path) ?? "unknown";
  return {
    logId: normalizeNonEmptyString(log.logId) ?? evidenceDebugId("log", stableSource),
    ...(log.sha256 ? { sha256: log.sha256 } : {}),
    ...(typeof log.sizeBytes === "number" && Number.isFinite(log.sizeBytes)
      ? { sizeBytes: log.sizeBytes }
      : {}),
    ...(log.status ? { status: log.status } : {}),
  };
}

function sanitizeEvidenceVerifierDecision(
  decision: ChildResultEvidenceVerifierDecision,
): ChildResultEvidenceVerifierDecision {
  return {
    decision: decision.decision,
    acceptanceEligible: decision.acceptanceEligible,
    parentObserved: decision.parentObserved,
    ...(decision.observedBy ? { observedBy: decision.observedBy } : {}),
    ...(decision.observedAt ? { observedAt: decision.observedAt } : {}),
    reasons: decision.reasons,
    ...(decision.verifiedCommands?.length
      ? {
          verifiedCommands: decision.verifiedCommands.map((command) => ({
            ...(command.commandId ? { commandId: command.commandId } : {}),
            ...(command.runId ? { runId: command.runId } : {}),
            status: command.status,
          })),
        }
      : {}),
    ...(decision.verifiedArtifacts?.length
      ? {
          verifiedArtifacts: decision.verifiedArtifacts.map((artifact) =>
            sanitizeVerifiedArtifactMetadata(artifact),
          ),
        }
      : {}),
    ...(decision.verifiedLogs?.length
      ? { verifiedLogs: decision.verifiedLogs.map((log) => sanitizeVerifiedLogMetadata(log)) }
      : {}),
  };
}

export function buildChildCompletionResultHash(rawText?: string | null): string {
  return sha256Text((rawText ?? "").trim());
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalizeRetryMechanismToken(value: unknown, fallback = "default"): string {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return fallback;
  }
  return (
    normalized
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}

function retryPromptFingerprint(
  attempt: Pick<ChildResultRetryAttempt, "promptHash" | "prompt">,
): string {
  const explicitHash = normalizeHash(attempt.promptHash);
  if (explicitHash) {
    return explicitHash;
  }
  const prompt = normalizeNonEmptyString(attempt.prompt);
  return prompt ? sha256Text(prompt) : "no_prompt";
}

export function buildChildResultRetryAttemptFingerprint(
  attempt: Pick<ChildResultRetryAttempt, "mechanismKey" | "profileKey" | "promptHash" | "prompt">,
): string {
  return [
    normalizeRetryMechanismToken(attempt.mechanismKey),
    normalizeRetryMechanismToken(attempt.profileKey, "default_profile"),
    retryPromptFingerprint(attempt),
  ].join("|");
}

function acceptedMechanismChangesForAttempt(
  attempt: Pick<ChildResultRetryAttempt, "mechanismKey" | "mechanismChanges">,
): ChildResultRetryMechanismChange[] {
  const accepted = new Set<string>(CHILD_RESULT_RETRY_MECHANISM_CHANGES);
  const values = [attempt.mechanismKey, ...(attempt.mechanismChanges ?? [])].map((value) =>
    normalizeRetryMechanismToken(value, ""),
  );
  return uniqueStrings(
    values.filter((value) => accepted.has(value)),
  ) as ChildResultRetryMechanismChange[];
}

function isMalformedRetryVerdict(verdict: unknown): boolean {
  const normalized = normalizeNonEmptyString(verdict)?.toUpperCase();
  if (!normalized) {
    return false;
  }
  return (CHILD_RESULT_RETRY_MALFORMED_VERDICTS as readonly string[]).includes(normalized);
}

export function decideChildResultRetryPolicy(params: {
  previousAttempts: ChildResultRetryAttempt[];
  nextAttempt?: Pick<
    ChildResultRetryAttempt,
    "mechanismKey" | "mechanismChanges" | "profileKey" | "promptHash" | "prompt"
  >;
}): ChildResultRetryPolicyDecision {
  const lastAttempt = params.previousAttempts.at(-1);
  const nextAttempt = {
    mechanismKey: params.nextAttempt?.mechanismKey ?? lastAttempt?.mechanismKey,
    profileKey: params.nextAttempt?.profileKey ?? lastAttempt?.profileKey,
    promptHash: params.nextAttempt?.promptHash ?? lastAttempt?.promptHash,
    prompt: params.nextAttempt?.prompt ?? lastAttempt?.prompt,
    mechanismChanges: params.nextAttempt?.mechanismChanges,
  };
  const nextMechanismKey = normalizeRetryMechanismToken(nextAttempt.mechanismKey);
  const nextAttemptFingerprint = buildChildResultRetryAttemptFingerprint(nextAttempt);
  const acceptedMechanismChanges = acceptedMechanismChangesForAttempt(nextAttempt);
  const malformedAttempts = params.previousAttempts.filter((attempt) =>
    isMalformedRetryVerdict(attempt.contractVerdict),
  );
  const sameMechanismMalformedRetries = malformedAttempts.filter(
    (attempt) => normalizeRetryMechanismToken(attempt.mechanismKey) === nextMechanismKey,
  ).length;
  const sameAttemptFingerprintMalformedRetries = malformedAttempts.filter(
    (attempt) => buildChildResultRetryAttemptFingerprint(attempt) === nextAttemptFingerprint,
  ).length;
  const lastMalformedFingerprint = malformedAttempts.length
    ? buildChildResultRetryAttemptFingerprint(malformedAttempts[malformedAttempts.length - 1])
    : undefined;
  const changedProfileOrPrompt = Boolean(
    lastMalformedFingerprint &&
    lastMalformedFingerprint !== nextAttemptFingerprint &&
    sameMechanismMalformedRetries > 0,
  );

  if (sameAttemptFingerprintMalformedRetries <= 1 || acceptedMechanismChanges.length > 0) {
    const reasons =
      acceptedMechanismChanges.length > 0
        ? ["RETRY_MECHANISM_CHANGED"]
        : changedProfileOrPrompt
          ? ["RETRY_PROFILE_OR_PROMPT_CHANGED"]
          : ["SAME_ATTEMPT_FINGERPRINT_RETRY_ALLOWED"];
    return {
      acceptedMechanismChanges,
      changedProfileOrPrompt,
      directVerificationRequired: false,
      nextAttemptFingerprint,
      nextMechanismKey,
      reasons,
      requiredMechanismChanges: CHILD_RESULT_RETRY_MECHANISM_CHANGES,
      retryAllowed: true,
      sameAttemptFingerprintMalformedRetries,
      sameMechanismMalformedRetries,
      verdict: CHILD_RESULT_RETRY_ALLOWED,
    };
  }

  return {
    acceptedMechanismChanges,
    changedProfileOrPrompt: false,
    directVerificationRequired: true,
    nextAttemptFingerprint,
    nextMechanismKey,
    reasons: [
      "IDENTICAL_MECHANISM_PROFILE_PROMPT_RETRY_LIMIT_EXCEEDED",
      "DIRECT_VERIFICATION_REQUIRED",
    ],
    requiredMechanismChanges: CHILD_RESULT_RETRY_MECHANISM_CHANGES,
    retryAllowed: false,
    sameAttemptFingerprintMalformedRetries,
    sameMechanismMalformedRetries,
    verdict: CHILD_RESULT_RETRY_POLICY_EXHAUSTED,
  };
}

export function classifyTransportOutcome(
  outcome?: ChildRunOutcomeLike,
): ChildResultTransportOutcome {
  if (outcome?.status === "ok") {
    return "completed";
  }
  if (outcome?.status === "error") {
    return "failed";
  }
  if (outcome?.status === "timeout") {
    return "timeout";
  }
  if (outcome?.status === "cancelled" || outcome?.status === "canceled") {
    return "cancelled";
  }
  return "unknown";
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, Math.max(0, maxChars))}\n[truncated]`, truncated: true };
}

function scanSensitivity(text: string): ChildResultRedactionSummary {
  const flags = new Set<string>();
  const tokenLikeCount = (
    text.match(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    ) ?? []
  ).length;
  const credentialKeyCount = (
    text.match(/\b(?:api[_-]?key|token|secret|password)\b\s*[:=]/gi) ?? []
  ).length;
  const privateKeyLikeCount = (text.match(/-----BEGIN [^-]+ PRIVATE KEY-----/g) ?? []).length;
  if (tokenLikeCount > 0) {
    flags.add("TOKEN_LIKE_VALUE");
  }
  if (credentialKeyCount > 0) {
    flags.add("CREDENTIAL_KEY");
  }
  if (privateKeyLikeCount > 0) {
    flags.add("PRIVATE_KEY_BLOCK");
  }
  return {
    scanned: true,
    redacted: flags.size > 0,
    flags: [...flags].toSorted(),
    tokenLikeCount,
    credentialKeyCount,
    privateKeyLikeCount,
    rawSnippetStored: false,
  };
}

function normalizeForParsing(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(NULL_BYTE_RE, "");
}

function defaultOpenClawQuarantineRoot(): string {
  const explicitDataDir = process.env.OPENCLAW_DATA_DIR?.trim();
  if (explicitDataDir) {
    return path.join(explicitDataDir, "quarantine", "child-results");
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(stateDir, "data", "quarantine", "child-results");
  }
  const openclawHome = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "data", "quarantine", "child-results");
}

function quarantineRootFromParams(
  params: Pick<ChildResultClassificationParams, "quarantineRoot">,
): string {
  return (
    params.quarantineRoot ||
    process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR ||
    defaultOpenClawQuarantineRoot()
  );
}

function allowUnsafeQuarantineRoot(params: { allowUnsafeQuarantineRoot?: boolean }): boolean {
  return (
    params.allowUnsafeQuarantineRoot === true ||
    process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_ALLOW_UNSAFE_FOR_TEST === "1"
  );
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isUnsafeDefaultStoragePath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const tmp = path.resolve(os.tmpdir());
  const cwd = path.resolve(process.cwd());
  const parts = resolved.split(path.sep).filter(Boolean);
  const unsafeWorkspacePart = parts.some(
    (part) => part === "worktrees" || part === "repos" || part === "projects",
  );
  return (
    isPathInside(resolved, tmp) ||
    isPathInside(resolved, cwd) ||
    unsafeWorkspacePart ||
    resolved.includes(`${path.sep}.git${path.sep}`) ||
    resolved.endsWith(`${path.sep}.git`)
  );
}

function existingPathPrefix(target: string): string {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

function validateExistingParents(target: string, allowUnsafe: boolean): string | undefined {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = existingPathPrefix(resolved);
  const visited: string[] = [];
  while (current && current !== root) {
    visited.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  for (const candidate of visited) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      return `PARENT_STAT_FAILED:${candidate}`;
    }
    if (stat.isSymbolicLink()) {
      return `SYMLINK_PARENT_REJECTED:${candidate}`;
    }
    if (!stat.isDirectory()) {
      return `NON_DIRECTORY_PARENT_REJECTED:${candidate}`;
    }
    if (!allowUnsafe && (stat.mode & 0o022) !== 0) {
      return `GROUP_OR_WORLD_WRITABLE_PARENT_REJECTED:${candidate}`;
    }
  }
  return undefined;
}

function ensurePrivateDirectory(
  root: string,
  allowUnsafe: boolean,
): { ok: true; root: string } | { ok: false; reason: string } {
  const resolved = path.resolve(root);
  if (!path.isAbsolute(root)) {
    return { ok: false, reason: "QUARANTINE_ROOT_NOT_ABSOLUTE" };
  }
  const normalized = path.normalize(root);
  if (normalized.split(path.sep).includes("..")) {
    return { ok: false, reason: "QUARANTINE_ROOT_TRAVERSAL" };
  }
  if (!allowUnsafe && isUnsafeDefaultStoragePath(resolved)) {
    return { ok: false, reason: "QUARANTINE_ROOT_UNSAFE_LOCATION" };
  }
  const parentIssue = validateExistingParents(resolved, allowUnsafe);
  if (parentIssue) {
    return { ok: false, reason: parentIssue };
  }
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: POSIX_PRIVATE_DIR_MODE });
    fs.chmodSync(resolved, POSIX_PRIVATE_DIR_MODE);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: "QUARANTINE_ROOT_SYMLINK" };
    }
    if (!stat.isDirectory()) {
      return { ok: false, reason: "QUARANTINE_ROOT_NOT_DIRECTORY" };
    }
    if (!allowUnsafe && (stat.mode & 0o077) !== 0) {
      return { ok: false, reason: "QUARANTINE_ROOT_NOT_PRIVATE" };
    }
    writeQuarantineMarkerFiles(resolved);
    return { ok: true, root: resolved };
  } catch (err) {
    return {
      ok: false,
      reason: `QUARANTINE_ROOT_UNAVAILABLE:${(err as NodeJS.ErrnoException).code ?? "error"}`,
    };
  }
}

function writeFileAtomic(filePath: string, content: string | Buffer): number {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.tmp-${randomBytes(18).toString("base64url")}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", POSIX_PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, POSIX_PRIVATE_FILE_MODE);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const stat = fs.lstatSync(tempPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error("unsafe_temp_file");
    }
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, POSIX_PRIVATE_FILE_MODE);
    const finalStat = fs.lstatSync(filePath);
    if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.nlink !== 1) {
      throw new Error("unsafe_final_file");
    }
    return finalStat.size;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort cleanup below
      }
    }
    try {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
    } catch {
      // best effort only
    }
  }
}

function writeQuarantineMarkerFiles(root: string): void {
  const gitignorePath = path.join(root, ".gitignore");
  const nosyncPath = path.join(root, ".nosync");
  if (!fs.existsSync(gitignorePath)) {
    writeFileAtomic(gitignorePath, "*\n!.gitignore\n!.nosync\n");
  }
  if (!fs.existsSync(nosyncPath)) {
    writeFileAtomic(
      nosyncPath,
      "OpenClaw quarantine storage: do not sync or back up unless encrypted.\n",
    );
  }
}

function quarantineStoreStats(root: string): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink() || stat.nlink !== 1) {
      continue;
    }
    bytes += stat.size;
    count += 1;
  }
  return { bytes, count };
}

function retentionMetadata(params: {
  createdAt: string;
  ttlDays?: number;
  maxStoreBytes?: number;
  maxStoreCount?: number;
}): ChildResultRetentionMetadata {
  const ttlDays = Math.max(
    1,
    Math.floor(params.ttlDays ?? CHILD_RESULT_DEFAULT_QUARANTINE_TTL_DAYS),
  );
  const createdMs = Date.parse(params.createdAt);
  const expiresAt = new Date(createdMs + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  return {
    ttlDays,
    expiresAt,
    cleanupEligibleAt: expiresAt,
    maxStoreBytes: Math.max(
      1,
      params.maxStoreBytes ?? CHILD_RESULT_DEFAULT_MAX_QUARANTINE_STORE_BYTES,
    ),
    maxStoreCount: Math.max(
      1,
      params.maxStoreCount ?? CHILD_RESULT_DEFAULT_MAX_QUARANTINE_STORE_COUNT,
    ),
    cleanupPolicy: "ttl_and_quota",
    operatorDeletion: "supported_by_artifact_id",
    gitExcluded: true,
    syncExcluded: true,
    backupExcludedUnlessEncrypted: true,
    encryptionAtRest: "not_implemented",
    encryptionException: CHILD_RESULT_QUARANTINE_ENCRYPTION_EXCEPTION,
  };
}

function quarantineRecord(params: {
  artifactId: string;
  rawSha256: string;
  sizeBytes: number;
  source: ChildResultRawSource;
  createdAt: string;
  reason: ChildResultContractVerdictLike;
  status: ChildResultNormalizedState;
  classifications: ChildResultClassificationLabel[];
  storageStatus: ChildResultQuarantineStorageStatus;
  payloadStored: boolean;
  storedSizeBytes: number;
  redaction: ChildResultRedactionSummary;
  retention: ChildResultRetentionMetadata;
  truncated?: boolean;
  metadataPath?: string;
  payloadPath?: string;
  childSessionKey?: string;
  childRunId?: string;
  requesterSessionKey?: string;
  taskLabel?: string;
  unavailableReason?: string;
}): ChildResultQuarantineArtifact {
  return {
    schemaVersion: CHILD_RESULT_QUARANTINE_SCHEMA_VERSION,
    artifactId: params.artifactId,
    ...(params.metadataPath
      ? { path: params.metadataPath, metadataPath: params.metadataPath }
      : {}),
    ...(params.payloadPath ? { payloadPath: params.payloadPath } : {}),
    sha256: params.rawSha256,
    payloadSha256: params.rawSha256,
    sizeBytes: params.sizeBytes,
    byteCount: params.sizeBytes,
    storedSizeBytes: params.storedSizeBytes,
    source: params.source,
    capturedAt: params.createdAt,
    createdAt: params.createdAt,
    truncated: params.truncated === true,
    redacted: params.redaction.redacted,
    reason: params.reason,
    status: params.status,
    classifications: params.classifications,
    storageStatus: params.storageStatus,
    payloadStored: params.payloadStored,
    rawBodyIncludedInMetadata: false,
    redaction: params.redaction,
    retention: params.retention,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    ...(params.childRunId ? { childRunId: params.childRunId } : {}),
    ...(params.requesterSessionKey ? { requesterSessionKey: params.requesterSessionKey } : {}),
    ...(params.taskLabel ? { taskLabel: params.taskLabel } : {}),
    ...(params.unavailableReason ? { unavailableReason: params.unavailableReason } : {}),
  };
}

function metadataJsonForQuarantine(
  artifact: ChildResultQuarantineArtifact,
): Record<string, unknown> {
  return {
    schemaVersion: artifact.schemaVersion,
    kind: "subagent_child_result_quarantine",
    artifactId: artifact.artifactId,
    payloadSha256: artifact.payloadSha256,
    byteCount: artifact.byteCount,
    source: artifact.source,
    reason: artifact.reason,
    status: artifact.status,
    classifications: artifact.classifications,
    createdAt: artifact.createdAt,
    capturedAt: artifact.capturedAt,
    storageStatus: artifact.storageStatus,
    payloadStored: artifact.payloadStored,
    rawBodyIncludedInMetadata: false,
    redaction: artifact.redaction,
    retention: artifact.retention,
    ...(artifact.childSessionKey ? { childSessionKey: artifact.childSessionKey } : {}),
    ...(artifact.childRunId ? { childRunId: artifact.childRunId } : {}),
    ...(artifact.requesterSessionKey ? { requesterSessionKey: artifact.requesterSessionKey } : {}),
    ...(artifact.taskLabel ? { taskLabel: artifact.taskLabel } : {}),
    ...(artifact.unavailableReason ? { unavailableReason: artifact.unavailableReason } : {}),
  };
}

export function quarantineChildResultOutput(params: {
  rawText: string;
  source?: ChildResultRawSource;
  reason: ChildResultContractVerdictLike;
  quarantineRoot?: string;
  maxBodyChars?: number;
  maxArtifactBytes?: number;
  maxStoreBytes?: number;
  maxStoreCount?: number;
  ttlDays?: number;
  status?: ChildResultNormalizedState;
  classifications?: ChildResultClassificationLabel[];
  allowUnsafeQuarantineRoot?: boolean;
  childSessionKey?: string;
  childRunId?: string;
  requesterSessionKey?: string;
  taskLabel?: string;
}): ChildResultQuarantineArtifact {
  const rawText = params.rawText;
  const source = params.source ?? "unknown";
  const rawSha256 = sha256Text(rawText);
  const sizeBytes = byteLength(rawText);
  const createdAt = new Date().toISOString();
  const artifactId = `q_${randomBytes(24).toString("base64url")}`;
  const redaction = scanSensitivity(rawText);
  const retention = retentionMetadata({
    createdAt,
    ttlDays: params.ttlDays,
    maxStoreBytes: params.maxStoreBytes,
    maxStoreCount: params.maxStoreCount,
  });
  const baseLabels = uniqueClassificationLabels([
    ...(params.classifications ?? []),
    sizeBytes >
    Math.max(1, params.maxArtifactBytes ?? CHILD_RESULT_DEFAULT_MAX_QUARANTINE_ARTIFACT_BYTES)
      ? "OVERSIZE_OUTPUT"
      : undefined,
  ]);
  const status =
    params.status ?? (baseLabels.includes("INFRA_BLOCKED") ? "INFRA_BLOCKED" : "MALFORMED");
  const common = {
    artifactId,
    rawSha256,
    sizeBytes,
    source,
    createdAt,
    reason: params.reason,
    redaction,
    retention,
    childSessionKey: params.childSessionKey,
    childRunId: params.childRunId,
    requesterSessionKey: params.requesterSessionKey,
    taskLabel: params.taskLabel,
  };
  const maxArtifactBytes = Math.max(
    1,
    params.maxArtifactBytes ?? CHILD_RESULT_DEFAULT_MAX_QUARANTINE_ARTIFACT_BYTES,
  );
  if (sizeBytes > maxArtifactBytes) {
    return quarantineRecord({
      ...common,
      status: "MALFORMED",
      classifications: uniqueClassificationLabels([...baseLabels, "OVERSIZE_OUTPUT"]),
      storageStatus: "metadata_only",
      payloadStored: false,
      storedSizeBytes: 0,
      truncated: true,
      unavailableReason: "OVERSIZE_OUTPUT",
    });
  }

  const rootResult = ensurePrivateDirectory(
    quarantineRootFromParams({ quarantineRoot: params.quarantineRoot }),
    allowUnsafeQuarantineRoot(params),
  );
  if (!rootResult.ok) {
    return quarantineRecord({
      ...common,
      status: "INFRA_BLOCKED",
      classifications: uniqueClassificationLabels([...baseLabels, "INFRA_BLOCKED"]),
      storageStatus: "unavailable",
      payloadStored: false,
      storedSizeBytes: 0,
      unavailableReason: rootResult.reason,
    });
  }

  try {
    const storeStats = quarantineStoreStats(rootResult.root);
    if (
      storeStats.bytes + sizeBytes > retention.maxStoreBytes ||
      storeStats.count + 2 > retention.maxStoreCount
    ) {
      return quarantineRecord({
        ...common,
        status: "INFRA_BLOCKED",
        classifications: uniqueClassificationLabels([...baseLabels, "INFRA_BLOCKED"]),
        storageStatus: "unavailable",
        payloadStored: false,
        storedSizeBytes: 0,
        unavailableReason: "QUARANTINE_STORE_QUOTA_EXCEEDED",
      });
    }

    const payloadPath = path.join(rootResult.root, `payload-${artifactId}.bin`);
    const metadataPath = path.join(rootResult.root, `meta-${artifactId}.json`);
    const payloadStoredSize = writeFileAtomic(payloadPath, Buffer.from(rawText, "utf8"));
    const artifact = quarantineRecord({
      ...common,
      status,
      classifications: baseLabels,
      storageStatus: "stored",
      payloadStored: true,
      storedSizeBytes: payloadStoredSize,
      metadataPath,
      payloadPath,
    });
    const metadataSize = writeFileAtomic(
      metadataPath,
      `${JSON.stringify(metadataJsonForQuarantine(artifact), null, 2)}\n`,
    );
    return { ...artifact, storedSizeBytes: payloadStoredSize + metadataSize };
  } catch (err) {
    return quarantineRecord({
      ...common,
      status: "INFRA_BLOCKED",
      classifications: uniqueClassificationLabels([...baseLabels, "INFRA_BLOCKED"]),
      storageStatus: "unavailable",
      payloadStored: false,
      storedSizeBytes: 0,
      unavailableReason: `QUARANTINE_WRITE_FAILED:${(err as NodeJS.ErrnoException).code ?? "error"}`,
    });
  }
}

type JsonCandidate =
  | {
      ok: true;
      value: unknown;
      parserMode: Exclude<
        ChildResultParserMode,
        "legacy_plaintext" | "malformed_json" | "no_output"
      >;
      strictJson: boolean;
      labels: ChildResultClassificationLabel[];
    }
  | {
      ok: false;
      parserMode: "malformed_json" | "no_output";
      strictJson: false;
      labels: ChildResultClassificationLabel[];
    };

function firstJsonCandidate(text: string): JsonCandidate {
  const trimmed = normalizeForParsing(text).trim();
  if (!trimmed) {
    return { ok: false, parserMode: "no_output", strictJson: false, labels: ["NO_OUTPUT"] };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(trimmed),
      parserMode: "strict_json",
      strictJson: true,
      labels: [],
    };
  } catch {
    // Continue with common fenced/embedded forms. These are parsed for failure propagation
    // and metadata, but they are deliberately not strict acceptance evidence.
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return {
        ok: true,
        value: JSON.parse(fenced[1].trim()),
        parserMode: "fenced_json",
        strictJson: false,
        labels: ["PARTIAL_OUTPUT", "SCHEMA_INVALID"],
      };
    } catch {
      return {
        ok: false,
        parserMode: "malformed_json",
        strictJson: false,
        labels: ["PARTIAL_OUTPUT", "SCHEMA_INVALID"],
      };
    }
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 || lastBrace >= 0) {
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return {
          ok: true,
          value: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)),
          parserMode: "embedded_json",
          strictJson: false,
          labels: ["PARTIAL_OUTPUT", "SCHEMA_INVALID"],
        };
      } catch {
        // Fall through to malformed JSON.
      }
    }
    return {
      ok: false,
      parserMode: "malformed_json",
      strictJson: false,
      labels: ["SCHEMA_INVALID"],
    };
  }
  return { ok: false, parserMode: "malformed_json", strictJson: false, labels: [] };
}

function extractArtifactList(value: unknown): ChildResultReportedArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const artifacts: ChildResultReportedArtifact[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const artifactPath = normalizeNonEmptyString(item);
      if (artifactPath) {
        artifacts.push({ path: artifactPath });
      }
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const artifactPath = normalizeNonEmptyString(item.path ?? item.file ?? item.artifactPath);
    if (!artifactPath) {
      continue;
    }
    artifacts.push({
      path: artifactPath,
      ...(normalizeHash(item.sha256) ? { sha256: normalizeHash(item.sha256) } : {}),
    });
  }
  return artifacts;
}

function extractOutputArtifactReportFields(parsed: Record<string, unknown>): {
  artifactObjects: ChildResultReportedArtifact[];
  outputArtifactPaths: string[];
} {
  const artifactObjects = [
    ...extractArtifactList(parsed.outputArtifacts),
    ...extractArtifactList(parsed.artifacts),
    ...extractArtifactList(parsed.reportArtifacts),
  ];
  const outputArtifactPaths = uniqueStrings([
    ...normalizeStringArray(parsed.outputArtifactPaths),
    ...normalizeStringArray(parsed.artifactPaths),
    ...artifactObjects.map((artifact) => artifact.path),
    ...(normalizeNonEmptyString(parsed.outputArtifactPath)
      ? [normalizeNonEmptyString(parsed.outputArtifactPath)!]
      : []),
    ...(normalizeNonEmptyString(parsed.reportPath)
      ? [normalizeNonEmptyString(parsed.reportPath)!]
      : []),
  ]);
  return { artifactObjects, outputArtifactPaths };
}

function parsePlainVerdict(text: string): ParsedChildResultReport | undefined {
  const trimmed = text.trim();
  const reportWrittenMatch = /^REPORT_WRITTEN\s+([^\s]+)\s*$/i.exec(trimmed);
  if (reportWrittenMatch?.[1]) {
    return {
      schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
      parserMode: "legacy_plaintext",
      strictJson: false,
      schemaValid: false,
      normalizedState: "UNVERIFIED",
      classificationLabels: ["SCHEMA_INVALID", "EVIDENCE_UNVERIFIED"],
      verdict: "PASS",
      outputArtifactPaths: [reportWrittenMatch[1]],
      outputArtifacts: [{ path: reportWrittenMatch[1] }],
      changedPaths: [],
      sourcePaths: [],
      commandsRun: [],
    };
  }
  const failedMatch = /^FAILED\b(?:\s*\(\s*failures\s*=\s*(\d+)\s*\))?/i.exec(trimmed);
  if (failedMatch) {
    return {
      schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
      parserMode: "legacy_plaintext",
      strictJson: false,
      schemaValid: false,
      normalizedState: "FAIL",
      classificationLabels: ["SCHEMA_INVALID"],
      verdict: "FAILED",
      failures: failedMatch[1] ? Number.parseInt(failedMatch[1], 10) : undefined,
      outputArtifactPaths: [],
      outputArtifacts: [],
      changedPaths: [],
      sourcePaths: [],
      commandsRun: [],
    };
  }
  const verdictMatch = /^(PASS|PASSED|FAIL|FAILED|REJECT|REJECTED|REVISE|BLOCKED_INFRA)\b/i.exec(
    trimmed,
  );
  if (!verdictMatch?.[1]) {
    return undefined;
  }
  const normalizedVerdictText = verdictMatch[1].toUpperCase();
  const failed = normalizedVerdictText === "FAIL" || normalizedVerdictText === "FAILED";
  const blocked = normalizedVerdictText === "BLOCKED_INFRA";
  return {
    schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
    parserMode: "legacy_plaintext",
    strictJson: false,
    schemaValid: false,
    normalizedState: blocked ? "INFRA_BLOCKED" : failed ? "FAIL" : "UNVERIFIED",
    classificationLabels: blocked
      ? ["SCHEMA_INVALID", "INFRA_BLOCKED"]
      : failed
        ? ["SCHEMA_INVALID"]
        : ["SCHEMA_INVALID", "EVIDENCE_UNVERIFIED"],
    verdict: verdictMatch[1],
    outputArtifactPaths: [],
    outputArtifacts: [],
    changedPaths: [],
    sourcePaths: [],
    commandsRun: [],
  };
}

export function parseChildResultReport(rawText: string): ParsedChildResultReport | undefined {
  try {
    const candidate = firstJsonCandidate(rawText);
    if (!candidate.ok) {
      return parsePlainVerdict(rawText);
    }
    const parsed = candidate.value;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const { artifactObjects, outputArtifactPaths } = extractOutputArtifactReportFields(parsed);
    const verdict = normalizeNonEmptyString(parsed.verdict);
    const contractVerdict = normalizeNonEmptyString(parsed.contractVerdict);
    const normalized = (verdict ?? contractVerdict)?.trim().toUpperCase();
    const verdictKnown = Boolean(
      normalized &&
      [
        "PASS",
        "PASSED",
        "FAIL",
        "FAILED",
        "FAILED_GATES",
        "REJECT",
        "REJECTED",
        "REVISE",
        "BLOCKED_INFRA",
        CHILD_RESULT_SCHEMA_VALID,
      ].includes(normalized),
    );
    const labels = uniqueClassificationLabels([
      ...candidate.labels,
      !normalized ? "NO_VERDICT" : undefined,
      normalized && !verdictKnown ? "SCHEMA_INVALID" : undefined,
      candidate.strictJson && verdictKnown ? "SCHEMA_VALID" : undefined,
      normalized === "BLOCKED_INFRA" ? "INFRA_BLOCKED" : undefined,
    ]);
    const normalizedState: ChildResultNormalizedState =
      normalized === "BLOCKED_INFRA"
        ? "INFRA_BLOCKED"
        : normalized === "FAIL" ||
            normalized === "FAILED" ||
            normalized === "FAILED_GATES" ||
            normalized === "REJECT" ||
            normalized === "REJECTED" ||
            normalized === "REVISE"
          ? "FAIL"
          : normalized === "PASS" ||
              normalized === "PASSED" ||
              normalized === CHILD_RESULT_SCHEMA_VALID
            ? "UNVERIFIED"
            : "MALFORMED";

    return {
      schemaVersion:
        typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion)
          ? parsed.schemaVersion
          : CHILD_RESULT_SCHEMA_VERSION,
      parserMode: candidate.parserMode,
      strictJson: candidate.strictJson,
      schemaValid: candidate.strictJson && verdictKnown,
      normalizedState,
      classificationLabels: labels,
      verdict,
      contractVerdict,
      taskId: normalizeNonEmptyString(parsed.taskId ?? parsed.taskID ?? parsed.task),
      activeTaskContractId: normalizeNonEmptyString(
        parsed.activeTaskContractId ?? parsed.active_task_contract_id,
      ),
      failures:
        typeof parsed.failures === "number" && Number.isFinite(parsed.failures)
          ? parsed.failures
          : undefined,
      outputArtifactPaths,
      outputArtifacts: artifactObjects,
      changedPaths: normalizeStringArray(parsed.changedPaths),
      sourcePaths: normalizeStringArray(parsed.sourcePaths),
      commandsRun: Array.isArray(parsed.commandsRun)
        ? parsed.commandsRun.filter(isRecord)
        : Array.isArray(parsed.gates)
          ? parsed.gates.filter(isRecord)
          : [],
    };
  } catch {
    return undefined;
  }
}

function normalizedVerdict(report: ParsedChildResultReport): string | undefined {
  return (report.verdict ?? report.contractVerdict)?.trim().toUpperCase();
}

function commandStatusFailed(command: Record<string, unknown>): boolean {
  const status = normalizeNonEmptyString(
    command.status ?? command.result ?? command.outcome,
  )?.toLowerCase();
  if (status && ["fail", "failed", "failure", "error", "rejected"].includes(status)) {
    return true;
  }
  for (const key of ["exit", "exitCode", "code"] as const) {
    const value = command[key];
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
      return true;
    }
  }
  return false;
}

function reportHasFailedGates(report: ParsedChildResultReport): boolean {
  const verdict = normalizedVerdict(report);
  if (verdict === "FAIL" || verdict === "FAILED" || verdict === "FAILED_GATES") {
    return true;
  }
  if (typeof report.failures === "number" && report.failures > 0) {
    return true;
  }
  return report.commandsRun.some(commandStatusFailed);
}

function reportIsRejected(report: ParsedChildResultReport): boolean {
  const verdict = normalizedVerdict(report);
  return (
    verdict === "REJECT" ||
    verdict === "REJECTED" ||
    verdict === "REVISE" ||
    verdict === "BLOCKED_INFRA"
  );
}

function reportIsPass(report: ParsedChildResultReport): boolean {
  const verdict = normalizedVerdict(report);
  return verdict === "PASS" || verdict === "PASSED" || verdict === CHILD_RESULT_SCHEMA_VALID;
}

function looksLikeToolLogOutput(text: string, source?: ChildResultRawSource): boolean {
  if (source === "tool_log") {
    return true;
  }
  const trimmed = normalizeForParsing(text).trim();
  if (!trimmed) {
    return false;
  }
  const patterns = [
    /Process exited with code\s+\d+/i,
    /Command (?:failed|exited|still running)/i,
    /^Exit code:\s*\d+/im,
    /^Tool(?:Result| result)\b/im,
    /toolCallId|toolName|function_call|functionCall/,
    /^\s*(?:\$\s*)?(?:rg|grep|sed|cat|python|node|pnpm|npm|vitest)\b/im,
  ];
  return patterns.some((pattern) => pattern.test(trimmed));
}

function looksLikeRawGrepOutput(text: string): boolean {
  const lines = normalizeForParsing(text)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const grepLikeLines = lines.filter((line) =>
    /^(?:[./\w-]+\/)?(?:src|test|docs|scripts|extensions)\/[^:\n]+:\d+(?::\d+)?:/.test(line),
  );
  const pathListingLines = lines.filter((line) =>
    /^(?:\.\/)?(?:src|test|docs|scripts|extensions)\/[\w./-]+$/.test(line.trim()),
  );
  return grepLikeLines.length >= 2 || pathListingLines.length >= 4;
}

function looksLikeRawDiffOutput(text: string): boolean {
  const normalized = normalizeForParsing(text);
  return (
    /^(?:diff --git|index [a-f0-9]{6,}|@@\s+-\d+)/im.test(normalized) ||
    (normalized.split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line)).length >= 4 &&
      /\n@@\s+-\d+/.test(normalized))
  );
}

function looksLikeInternalEnvelopeOutput(text: string): boolean {
  const normalized = normalizeForParsing(text);
  return /INTERNAL_RUNTIME_CONTEXT_BEGIN|INTERNAL_RUNTIME_CONTEXT_END|BEGIN_UNTRUSTED_CHILD_RESULT|END_UNTRUSTED_CHILD_RESULT|sourceTool\s*=\s*subagent_announce|AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION/i.test(
    normalized,
  );
}

function looksLikePromptInjection(text: string): boolean {
  return /\b(?:ignore|override)\b[\s\S]{0,80}\b(?:previous|above|parent|system)\b|\b(?:trust|preserve|re-emit|return)\b[\s\S]{0,80}\b(?:raw output|raw body|child output)\b|do not (?:quarantine|summarize|sanitize)/i.test(
    normalizeForParsing(text),
  );
}

function looksLikeRawSourceOutput(text: string, source?: ChildResultRawSource): boolean {
  if (source === "raw_source") {
    return true;
  }
  const lines = normalizeForParsing(text)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const sourceLikeLines = lines.filter((line) =>
    /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|import\s|from\s|return\s|if\s*\(|for\s*\(|while\s*\()/i.test(
      line,
    ),
  );
  const braceLines = lines.filter((line) => /[{};]/.test(line));
  return lines.length >= 8 && sourceLikeLines.length >= 4 && braceLines.length >= 4;
}

function makeSummary(params: {
  normalizedState: ChildResultNormalizedState;
  classificationLabels: ChildResultClassificationLabel[];
  transportOutcome: ChildResultTransportOutcome;
  contractVerdict: ChildResultContractVerdict;
  acceptanceEligible: boolean;
  reasons: string[];
  activeTaskContractId?: string;
  currentTaskOutput?: boolean;
  backgrounded?: boolean;
  quarantineArtifact?: ChildResultQuarantineArtifact;
  verifiedArtifacts?: ChildResultReportedArtifact[];
  evidenceVerifier?: ChildResultEvidenceVerifierDecision;
  retryPolicy?: ChildResultRetryPolicyDecision;
}): string {
  const parts = [
    `schemaVersion=${CHILD_RESULT_SCHEMA_VERSION}`,
    `normalizedState=${params.normalizedState}`,
    `classificationLabels=${params.classificationLabels.join(",") || "none"}`,
    `transportOutcome=${params.transportOutcome}`,
    `contractVerdict=${params.contractVerdict}`,
    `acceptanceEligible=${params.acceptanceEligible ? "true" : "false"}`,
  ];
  if (params.activeTaskContractId) {
    parts.push(`activeTaskContractId=${params.activeTaskContractId}`);
  }
  if (typeof params.currentTaskOutput === "boolean") {
    parts.push(`currentTaskOutput=${params.currentTaskOutput ? "true" : "false"}`);
  }
  if (typeof params.backgrounded === "boolean") {
    parts.push(`backgrounded=${params.backgrounded ? "true" : "false"}`);
  }
  if (params.reasons.length > 0) {
    parts.push(`reasons=${params.reasons.join(",")}`);
  }
  if (params.verifiedArtifacts && params.verifiedArtifacts.length > 0) {
    parts.push(
      `verifiedArtifacts=${params.verifiedArtifacts
        .map((artifact) => sanitizeVerifiedArtifactMetadata(artifact).artifactId)
        .join(",")}`,
    );
  }
  if (params.evidenceVerifier) {
    parts.push(
      `evidenceVerifier=${params.evidenceVerifier.decision}`,
      `evidenceParentObserved=${params.evidenceVerifier.parentObserved ? "true" : "false"}`,
    );
  }
  if (params.quarantineArtifact) {
    parts.push(
      `quarantineArtifact=${params.quarantineArtifact.artifactId}`,
      `quarantineSha256=${params.quarantineArtifact.payloadSha256}`,
      `quarantineSizeBytes=${params.quarantineArtifact.byteCount}`,
      `quarantineSource=${params.quarantineArtifact.source}`,
      `quarantineStorageStatus=${params.quarantineArtifact.storageStatus}`,
    );
  }
  if (params.retryPolicy) {
    parts.push(
      `retryPolicy=${params.retryPolicy.verdict}`,
      `retryAllowed=${params.retryPolicy.retryAllowed ? "true" : "false"}`,
      `directVerificationRequired=${params.retryPolicy.directVerificationRequired ? "true" : "false"}`,
    );
  }
  return truncateText(parts.join("\n"), DEFAULT_MAX_PARENT_SUMMARY_CHARS).text;
}

export function buildChildResultSanitizedMetadata(
  result: Pick<
    ChildResultClassification,
    | "normalizedState"
    | "classificationLabels"
    | "transportOutcome"
    | "contractVerdict"
    | "acceptanceEligible"
    | "reasons"
    | "activeTaskContractId"
    | "currentTaskOutput"
    | "backgrounded"
    | "quarantineArtifact"
    | "verifiedArtifacts"
    | "evidenceVerifier"
    | "retryPolicy"
  >,
): ChildResultSanitizedMetadata {
  return {
    schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
    normalizedState: result.normalizedState,
    contractVerdict: result.contractVerdict,
    acceptanceEligible: result.acceptanceEligible,
    classificationLabels: result.classificationLabels,
    reasons: result.reasons,
    transportOutcome: result.transportOutcome,
    ...(result.activeTaskContractId ? { activeTaskContractId: result.activeTaskContractId } : {}),
    ...(typeof result.currentTaskOutput === "boolean"
      ? { currentTaskOutput: result.currentTaskOutput }
      : {}),
    ...(typeof result.backgrounded === "boolean" ? { backgrounded: result.backgrounded } : {}),
    ...(result.quarantineArtifact
      ? {
          quarantine: {
            artifactId: result.quarantineArtifact.artifactId,
            payloadSha256: result.quarantineArtifact.payloadSha256,
            byteCount: result.quarantineArtifact.byteCount,
            source: result.quarantineArtifact.source,
            createdAt: result.quarantineArtifact.createdAt,
            storageStatus: result.quarantineArtifact.storageStatus,
            payloadStored: result.quarantineArtifact.payloadStored,
            redaction: result.quarantineArtifact.redaction,
            retention: result.quarantineArtifact.retention,
            ...(result.quarantineArtifact.unavailableReason
              ? { unavailableReason: result.quarantineArtifact.unavailableReason }
              : {}),
          },
        }
      : {}),
    ...(result.verifiedArtifacts
      ? {
          verifiedArtifacts: result.verifiedArtifacts.map((artifact) =>
            sanitizeVerifiedArtifactMetadata(artifact),
          ),
        }
      : {}),
    ...(result.evidenceVerifier
      ? { evidenceVerifier: sanitizeEvidenceVerifierDecision(result.evidenceVerifier) }
      : {}),
    ...(result.retryPolicy ? { retryPolicy: result.retryPolicy } : {}),
  };
}

function classification(params: {
  transportOutcome: ChildResultTransportOutcome;
  contractVerdict: ChildResultContractVerdict;
  acceptanceEligible?: boolean;
  reasons?: string[];
  labels?: ChildResultClassificationLabel[];
  normalizedState?: ChildResultNormalizedState;
  activeTaskContractId?: string;
  currentTaskOutput?: boolean;
  backgrounded?: boolean;
  parsedReport?: ParsedChildResultReport;
  quarantineArtifact?: ChildResultQuarantineArtifact;
  verifiedArtifacts?: ChildResultReportedArtifact[];
  evidenceVerifier?: ChildResultEvidenceVerifierDecision;
  retryPolicy?: ChildResultRetryPolicyDecision;
}): ChildResultClassification {
  const acceptanceEligible = params.acceptanceEligible === true;
  const reasons = params.reasons ?? [];
  const baseClassificationLabels = uniqueClassificationLabels([
    labelForContractVerdict(params.contractVerdict),
    ...(params.parsedReport?.classificationLabels ?? []),
    ...(params.quarantineArtifact?.classifications ?? []),
    ...(params.labels ?? []),
    ...classificationLabelsForReasons(reasons),
  ]);
  const normalizedState =
    params.normalizedState ??
    normalizedStateForContractVerdict({
      verdict: params.contractVerdict,
      acceptanceEligible,
      transportOutcome: params.transportOutcome,
      labels: baseClassificationLabels,
    });
  const classificationLabels = uniqueClassificationLabels([
    ...baseClassificationLabels,
    params.quarantineArtifact && "MALFORMED_QUARANTINED",
    normalizedState === "UNVERIFIED" && "UNVERIFIED",
    !acceptanceEligible && "NOT_ACCEPTANCE_EVIDENCE",
  ]);
  const base = {
    schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
    normalizedState,
    classificationLabels,
    transportOutcome: params.transportOutcome,
    contractVerdict: params.contractVerdict,
    acceptanceEligible,
    reasons,
    ...(params.activeTaskContractId ? { activeTaskContractId: params.activeTaskContractId } : {}),
    ...(typeof params.currentTaskOutput === "boolean"
      ? { currentTaskOutput: params.currentTaskOutput }
      : {}),
    ...(typeof params.backgrounded === "boolean" ? { backgrounded: params.backgrounded } : {}),
    ...(params.parsedReport ? { parsedReport: params.parsedReport } : {}),
    ...(params.quarantineArtifact ? { quarantineArtifact: params.quarantineArtifact } : {}),
    ...(params.verifiedArtifacts ? { verifiedArtifacts: params.verifiedArtifacts } : {}),
    ...(params.evidenceVerifier ? { evidenceVerifier: params.evidenceVerifier } : {}),
    ...(params.retryPolicy ? { retryPolicy: params.retryPolicy } : {}),
  };
  const sanitizedMetadata = buildChildResultSanitizedMetadata(base);
  return {
    ...base,
    sanitizedMetadata,
    safeSummary: makeSummary({
      normalizedState,
      classificationLabels,
      transportOutcome: params.transportOutcome,
      contractVerdict: params.contractVerdict,
      acceptanceEligible,
      reasons,
      activeTaskContractId: params.activeTaskContractId,
      currentTaskOutput: params.currentTaskOutput,
      backgrounded: params.backgrounded,
      quarantineArtifact: params.quarantineArtifact,
      verifiedArtifacts: params.verifiedArtifacts,
      evidenceVerifier: params.evidenceVerifier,
      retryPolicy: params.retryPolicy,
    }),
  };
}

function failedQuarantinedClassification(params: {
  rawText: string;
  source?: ChildResultRawSource;
  verdict:
    | typeof CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT
    | typeof CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT
    | typeof CHILD_RESULT_MISSING_VERDICT_SCHEMA;
  transportOutcome: ChildResultTransportOutcome;
  reason: string;
  labels?: ChildResultClassificationLabel[];
  quarantineRoot?: string;
  maxQuarantineBodyChars?: number;
  maxQuarantineArtifactBytes?: number;
  maxQuarantineStoreBytes?: number;
  maxQuarantineStoreCount?: number;
  quarantineTtlDays?: number;
  allowUnsafeQuarantineRoot?: boolean;
  childSessionKey?: string;
  childRunId?: string;
  requesterSessionKey?: string;
  taskLabel?: string;
}): ChildResultClassification {
  const labels = uniqueClassificationLabels([
    labelForContractVerdict(params.verdict),
    ...(params.labels ?? []),
  ]);
  const quarantineArtifact = quarantineChildResultOutput({
    rawText: params.rawText,
    source: params.source,
    reason: params.verdict,
    quarantineRoot: params.quarantineRoot,
    maxBodyChars: params.maxQuarantineBodyChars,
    maxArtifactBytes: params.maxQuarantineArtifactBytes,
    maxStoreBytes: params.maxQuarantineStoreBytes,
    maxStoreCount: params.maxQuarantineStoreCount,
    ttlDays: params.quarantineTtlDays,
    classifications: labels,
    status: "MALFORMED",
    allowUnsafeQuarantineRoot: params.allowUnsafeQuarantineRoot,
    childSessionKey: params.childSessionKey,
    childRunId: params.childRunId,
    requesterSessionKey: params.requesterSessionKey,
    taskLabel: params.taskLabel,
  });
  return classification({
    transportOutcome: params.transportOutcome,
    contractVerdict: params.verdict,
    acceptanceEligible: false,
    reasons: [params.reason],
    labels,
    quarantineArtifact,
  });
}

function reportedArtifactByPath(
  report: ParsedChildResultReport,
): Map<string, ChildResultReportedArtifact> {
  const artifacts = new Map<string, ChildResultReportedArtifact>();
  for (const artifactPath of report.outputArtifactPaths) {
    artifacts.set(artifactPath, { path: artifactPath });
  }
  for (const artifact of report.outputArtifacts) {
    artifacts.set(artifact.path, { ...artifacts.get(artifact.path), ...artifact });
  }
  return artifacts;
}

function expectedStubCreatedAtForPath(
  params: ChildResultClassificationParams,
  artifactPath: string,
): number | undefined {
  return params.expectedStubCreatedAtMsByPath?.[artifactPath] ?? params.expectedStubCreatedAtMs;
}

function artifactSchemaRequiresJson(artifact: ActiveTaskArtifact): boolean {
  const schema = artifact.schema?.trim().toLowerCase();
  return Boolean(schema) || artifact.path.endsWith(".json");
}

function validateArtifactSchema(
  artifact: ActiveTaskArtifact,
  content: Buffer,
  contractedArtifactPaths: ReadonlySet<string>,
): string | undefined {
  if (!artifactSchemaRequiresJson(artifact)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return "ARTIFACT_SCHEMA_INVALID";
  }
  if (!isRecord(parsed)) {
    return "ARTIFACT_SCHEMA_INVALID";
  }
  const schema = artifact.schema?.trim().toLowerCase();
  const verdict = normalizeNonEmptyString(parsed.verdict ?? parsed.contractVerdict)?.toUpperCase();
  if (schema && !verdict) {
    return "ARTIFACT_VERDICT_SCHEMA_INVALID";
  }
  if (verdict && ["PENDING", "STUB", "DRAFT", "IN_PROGRESS"].includes(verdict)) {
    return "ARTIFACT_STUB_NOT_FINAL";
  }
  if (schema && verdict && !["PASS", "PASSED", CHILD_RESULT_SCHEMA_VALID].includes(verdict)) {
    return "ARTIFACT_VERDICT_NOT_ACCEPTED";
  }

  const referencedPaths = extractOutputArtifactReportFields(parsed).outputArtifactPaths;
  const uncontractedReferences = referencedPaths.filter(
    (artifactPath) => !contractedArtifactPaths.has(artifactPath),
  );
  if (uncontractedReferences.length > 0) {
    return "ARTIFACT_REFERENCES_OUT_OF_CONTRACT_OUTPUT";
  }
  return undefined;
}

function fileSha256(filePath: string): { hash: string; content: Buffer } {
  const content = fs.readFileSync(filePath);
  return { hash: sha256Text(content), content };
}

function verifyExpectedArtifacts(params: {
  report: ParsedChildResultReport;
  expectedArtifacts: ActiveTaskArtifact[];
  classificationParams: ChildResultClassificationParams;
  transportOutcome: ChildResultTransportOutcome;
}): ChildResultClassification | { ok: true; verifiedArtifacts: ChildResultReportedArtifact[] } {
  const reported = reportedArtifactByPath(params.report);
  const reportedPaths = [...reported.keys()];
  const traversalReportedPaths = reportedPaths.filter(pathContainsTraversal);
  if (traversalReportedPaths.length > 0) {
    return classification({
      transportOutcome: params.transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: ["OUTPUT_ARTIFACT_PATH_TRAVERSAL", ...traversalReportedPaths],
      parsedReport: params.report,
    });
  }
  if (reportedPaths.length === 0) {
    return classification({
      transportOutcome: params.transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: ["PASS_WITHOUT_VERIFIABLE_ARTIFACT"],
      parsedReport: params.report,
    });
  }
  if (params.expectedArtifacts.length === 0) {
    return classification({
      transportOutcome: params.transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: ["OUTPUT_ARTIFACT_NOT_CONTRACTED"],
      parsedReport: params.report,
    });
  }

  const contractedArtifactPaths = new Set(
    params.expectedArtifacts.map((artifact) => artifact.path),
  );
  const uncontractedReportedPaths = reportedPaths.filter(
    (artifactPath) => !contractedArtifactPaths.has(artifactPath),
  );
  if (uncontractedReportedPaths.length > 0) {
    return classification({
      transportOutcome: params.transportOutcome,
      contractVerdict: CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
      acceptanceEligible: false,
      reasons: ["OUTPUT_ARTIFACT_NOT_CONTRACTED", ...uncontractedReportedPaths],
      parsedReport: params.report,
    });
  }

  const maxArtifactBytes = Math.max(
    1,
    params.classificationParams.maxVerifiedArtifactBytes ?? DEFAULT_MAX_VERIFIED_ARTIFACT_BYTES,
  );
  const verifiedArtifacts: ChildResultReportedArtifact[] = [];
  for (const expected of params.expectedArtifacts) {
    if (pathContainsTraversal(expected.path)) {
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        reasons: ["EXPECTED_OUTPUT_ARTIFACT_PATH_TRAVERSAL", expected.path],
        parsedReport: params.report,
      });
    }
    const reportedArtifact = reported.get(expected.path);
    if (!reportedArtifact) {
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
        acceptanceEligible: false,
        reasons: ["EXPECTED_OUTPUT_ARTIFACT_NOT_REPORTED", expected.path],
        parsedReport: params.report,
      });
    }
    if (!fs.existsSync(expected.path)) {
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
        acceptanceEligible: false,
        reasons: ["EXPECTED_OUTPUT_ARTIFACT_MISSING", expected.path],
        parsedReport: params.report,
      });
    }

    const stat = fs.lstatSync(expected.path);
    if (stat.isSymbolicLink()) {
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        reasons: ["EXPECTED_OUTPUT_ARTIFACT_SYMLINK_ESCAPE", expected.path],
        parsedReport: params.report,
      });
    }
    if (!stat.isFile()) {
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_MISSING_REQUIRED_ARTIFACT,
        acceptanceEligible: false,
        reasons: ["EXPECTED_OUTPUT_ARTIFACT_NOT_FILE", expected.path],
        parsedReport: params.report,
      });
    }
    if (stat.size > maxArtifactBytes) {
      const content = fs.readFileSync(expected.path, "utf8");
      const quarantineArtifact = quarantineChildResultOutput({
        rawText: content,
        source: "artifact",
        reason: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        quarantineRoot: params.classificationParams.quarantineRoot,
        maxBodyChars: params.classificationParams.maxQuarantineBodyChars,
        maxArtifactBytes: params.classificationParams.maxQuarantineArtifactBytes,
        maxStoreBytes: params.classificationParams.maxQuarantineStoreBytes,
        maxStoreCount: params.classificationParams.maxQuarantineStoreCount,
        ttlDays: params.classificationParams.quarantineTtlDays,
        allowUnsafeQuarantineRoot: params.classificationParams.allowUnsafeQuarantineRoot,
        childSessionKey: params.classificationParams.childSessionKey,
        childRunId: params.classificationParams.childRunId,
        requesterSessionKey: params.classificationParams.requesterSessionKey,
        taskLabel: params.classificationParams.taskLabel,
        status: "UNVERIFIED",
        classifications: ["EVIDENCE_UNVERIFIED", "OVERSIZE_OUTPUT"],
      });
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        reasons: ["ARTIFACT_EXCEEDS_BOUNDED_SIZE", expected.path],
        parsedReport: params.report,
        quarantineArtifact,
      });
    }

    const freshAfter = [
      params.classificationParams.spawnedAtMs,
      expectedStubCreatedAtForPath(params.classificationParams, expected.path),
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (freshAfter.some((timestamp) => stat.mtimeMs < timestamp)) {
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        reasons: ["ARTIFACT_NOT_FRESH", expected.path],
        parsedReport: params.report,
      });
    }

    const { hash, content } = fileSha256(expected.path);
    const schemaError = validateArtifactSchema(expected, content, contractedArtifactPaths);
    if (schemaError) {
      const quarantineArtifact = quarantineChildResultOutput({
        rawText: content.toString("utf8"),
        source: "artifact",
        reason: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        quarantineRoot: params.classificationParams.quarantineRoot,
        maxBodyChars: params.classificationParams.maxQuarantineBodyChars,
        maxArtifactBytes: params.classificationParams.maxQuarantineArtifactBytes,
        maxStoreBytes: params.classificationParams.maxQuarantineStoreBytes,
        maxStoreCount: params.classificationParams.maxQuarantineStoreCount,
        ttlDays: params.classificationParams.quarantineTtlDays,
        allowUnsafeQuarantineRoot: params.classificationParams.allowUnsafeQuarantineRoot,
        childSessionKey: params.classificationParams.childSessionKey,
        childRunId: params.classificationParams.childRunId,
        requesterSessionKey: params.classificationParams.requesterSessionKey,
        taskLabel: params.classificationParams.taskLabel,
        status: "UNVERIFIED",
        classifications: ["EVIDENCE_UNVERIFIED", "SCHEMA_INVALID"],
      });
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        reasons: [schemaError, expected.path],
        parsedReport: params.report,
        quarantineArtifact,
      });
    }

    const expectedHash = normalizeHash(expected.sha256);
    const parentHash = normalizeHash(
      params.classificationParams.parentPostflightHashes?.[expected.path],
    );
    const reportedHash = normalizeHash(reportedArtifact.sha256);
    const mismatchedHash = [expectedHash, parentHash, reportedHash].find(
      (candidate) => candidate && candidate !== hash,
    );
    if (mismatchedHash) {
      return classification({
        transportOutcome: params.transportOutcome,
        contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        reasons: ["ARTIFACT_HASH_MISMATCH", expected.path],
        parsedReport: params.report,
      });
    }

    verifiedArtifacts.push({ path: expected.path, sha256: hash });
  }
  return { ok: true, verifiedArtifacts };
}

function scopeDisagreement(
  report: ParsedChildResultReport,
  scope?: ChildResultScopeCheck,
): string[] {
  const reasons: string[] = [];
  if (scope?.allowedChangedPaths) {
    const allowed = new Set(scope.allowedChangedPaths);
    const extra = report.changedPaths.filter((changedPath) => !allowed.has(changedPath));
    if (extra.length > 0) {
      reasons.push(`CHANGED_PATHS_OUT_OF_SCOPE:${extra.join(",")}`);
    }
  }
  if (scope?.allowedSourcePaths) {
    const allowed = new Set(scope.allowedSourcePaths);
    const extra = report.sourcePaths.filter((sourcePath) => !allowed.has(sourcePath));
    if (extra.length > 0) {
      reasons.push(`SOURCE_PATHS_OUT_OF_SCOPE:${extra.join(",")}`);
    }
  }
  return reasons;
}

function runningScopedGates(processes?: ChildResultScopedGateProcess[]): string[] {
  if (!Array.isArray(processes)) {
    return [];
  }
  return processes
    .filter((gate) => RUNNING_GATE_STATUSES.has(gate.status.trim().toLowerCase()))
    .map((gate) => gate.name?.trim() || gate.status.trim());
}

function parentScopeEvidenceMissing(scope?: ChildResultScopeCheck): boolean {
  return (
    !scope || !Array.isArray(scope.allowedChangedPaths) || !Array.isArray(scope.allowedSourcePaths)
  );
}

function unverifiedScopedGateEvidence(processes?: ChildResultScopedGateProcess[]): string[] {
  if (!Array.isArray(processes) || processes.length === 0) {
    return ["SCOPED_GATE_PROCESS_STATUS_UNVERIFIED"];
  }
  return processes
    .filter((gate) => !CLEAN_GATE_EVIDENCE_STATUSES.has(gate.status.trim().toLowerCase()))
    .map((gate) => {
      const label = gate.name?.trim() || "scoped gate";
      return `SCOPED_GATE_PROCESS_STATUS_UNVERIFIED:${label}=${gate.status.trim()}`;
    });
}

const TRUSTED_PARENT_RUNTIME_OBSERVERS = new Set<string>(["parent_runtime", "checker", "mediator"]);
const CHILD_SELF_ATTESTATION_OBSERVERS = new Set<string>([
  "assistant",
  "child",
  "child_session",
  "subagent",
  "self",
]);

type EvidenceFileKind = "artifact" | "log";

type EvidenceFileVerification =
  | {
      ok: true;
      path?: string;
      sha256: string;
      id?: string;
      sizeBytes?: number;
    }
  | { ok: false; reasons: string[] };

function unixPathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

function pathContainsTraversal(value: string): boolean {
  return unixPathSegments(value).includes("..");
}

function finiteEvidenceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function evidenceObservedAtMs(
  value: { observedAt?: string; observedAtMs?: number } | undefined,
): number | undefined {
  const explicit = finiteEvidenceNumber(value?.observedAtMs);
  if (explicit !== undefined) {
    return explicit;
  }
  const text = normalizeNonEmptyString(value?.observedAt);
  if (!text) {
    return undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function evidenceObservedAtText(
  value: { observedAt?: string; observedAtMs?: number } | undefined,
): string | undefined {
  const text = normalizeNonEmptyString(value?.observedAt);
  if (text) {
    return text;
  }
  const ms = finiteEvidenceNumber(value?.observedAtMs);
  return ms !== undefined ? new Date(ms).toISOString() : undefined;
}

function scopePathsForKind(
  scope: ChildResultParentRuntimeScopeEvidence | undefined,
  kind: EvidenceFileKind,
): { exact: string[]; roots: string[] } {
  if (!scope) {
    return { exact: [], roots: [] };
  }
  return kind === "artifact"
    ? {
        exact: normalizeStringArray(scope.allowedArtifactPaths),
        roots: normalizeStringArray(scope.allowedArtifactRoots),
      }
    : {
        exact: normalizeStringArray(scope.allowedLogPaths),
        roots: normalizeStringArray(scope.allowedLogRoots),
      };
}

function realPathOrResolved(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function pathMatchesAllowedExact(
  candidate: string,
  realCandidate: string,
  allowedPath: string,
): boolean {
  const resolvedAllowed = path.resolve(allowedPath);
  const realAllowed = realPathOrResolved(allowedPath);
  return (
    candidate === allowedPath ||
    path.resolve(candidate) === resolvedAllowed ||
    realCandidate === resolvedAllowed ||
    realCandidate === realAllowed
  );
}

function pathInsideAllowedRoot(realCandidate: string, allowedRoot: string): boolean {
  const resolvedRoot = realPathOrResolved(allowedRoot);
  return isPathInside(realCandidate, resolvedRoot);
}

function evidencePathScopeReasons(params: {
  filePath: string;
  realPath: string;
  scope: ChildResultParentRuntimeScopeEvidence | undefined;
  kind: EvidenceFileKind;
}): string[] {
  const reasons: string[] = [];
  const { exact, roots } = scopePathsForKind(params.scope, params.kind);
  if (exact.length === 0 && roots.length === 0) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_SCOPE_MISSING:${params.filePath}`);
    return reasons;
  }
  for (const scopePath of [...exact, ...roots]) {
    if (pathContainsTraversal(scopePath)) {
      reasons.push(`PARENT_${params.kind.toUpperCase()}_SCOPE_TRAVERSAL:${scopePath}`);
    }
  }
  if (reasons.length > 0) {
    return reasons;
  }
  const exactMatch = exact.some((allowedPath) =>
    pathMatchesAllowedExact(params.filePath, params.realPath, allowedPath),
  );
  const rootMatch = roots.some((allowedRoot) =>
    pathInsideAllowedRoot(params.realPath, allowedRoot),
  );
  if (!exactMatch && !rootMatch) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_PATH_OUT_OF_SCOPE:${params.filePath}`);
  }
  return reasons;
}

function childBindingReasons(params: {
  label: string;
  expected?: string;
  actual?: string;
}): string[] {
  const expected = normalizeNonEmptyString(params.expected);
  const actual = normalizeNonEmptyString(params.actual);
  if (!expected) {
    return [];
  }
  if (!actual) {
    return [`${params.label}_MISSING`];
  }
  return actual === expected ? [] : [`${params.label}_MISMATCH:${actual}`];
}

function evidenceChildIdentityReasons(params: {
  evidence: {
    childRunId?: string;
    childSessionKey?: string;
    childSessionId?: string;
    sessionId?: string;
  };
  classificationParams: ChildResultClassificationParams;
}): string[] {
  return [
    ...childBindingReasons({
      label: "PARENT_RUNTIME_CHILD_RUN_ID",
      expected: params.classificationParams.childRunId,
      actual: params.evidence.childRunId,
    }),
    ...childBindingReasons({
      label: "PARENT_RUNTIME_CHILD_SESSION_KEY",
      expected: params.classificationParams.childSessionKey,
      actual: params.evidence.childSessionKey,
    }),
    ...childBindingReasons({
      label: "PARENT_RUNTIME_CHILD_SESSION_ID",
      expected: params.classificationParams.childSessionId,
      actual: params.evidence.childSessionId,
    }),
  ];
}

function evidenceFreshnessReasons(params: {
  label: string;
  observedAtMs?: number;
  spawnedAtMs?: number;
  mtimeMs?: number;
  filePath?: string;
}): string[] {
  const reasons: string[] = [];
  if (params.observedAtMs === undefined) {
    reasons.push(`${params.label}_OBSERVED_AT_MISSING`);
    return reasons;
  }
  if (params.spawnedAtMs !== undefined && params.observedAtMs + 1_000 < params.spawnedAtMs) {
    reasons.push(`${params.label}_PREDATES_CHILD_RUN`);
  }
  if (params.mtimeMs !== undefined && params.mtimeMs > params.observedAtMs + 1_000) {
    reasons.push(
      `${params.label}_STALE_AFTER_OBSERVATION${params.filePath ? `:${params.filePath}` : ""}`,
    );
  }
  return reasons;
}

function verifyParentObservedFileEvidence(params: {
  evidence: ChildResultParentRuntimeFileEvidence;
  kind: EvidenceFileKind;
  expectedSha256?: string;
  scope: ChildResultParentRuntimeScopeEvidence | undefined;
  classificationParams: ChildResultClassificationParams;
}): EvidenceFileVerification {
  const reasons: string[] = [];
  const expectedSha256 = normalizeHash(params.expectedSha256);
  const evidenceSha256 = normalizeHash(params.evidence.sha256);
  const rawPath = normalizeNonEmptyString(params.evidence.path);
  const evidenceId = normalizeNonEmptyString(
    params.kind === "artifact" ? params.evidence.artifactId : params.evidence.logId,
  );

  if (!evidenceSha256) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_HASH_INVALID`);
  }
  if (expectedSha256 && evidenceSha256 && expectedSha256 !== evidenceSha256) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_HASH_MISMATCH`);
  }
  reasons.push(
    ...evidenceChildIdentityReasons({
      evidence: params.evidence,
      classificationParams: params.classificationParams,
    }),
  );
  const observedAtMs = evidenceObservedAtMs(params.evidence);
  reasons.push(
    ...evidenceFreshnessReasons({
      label: `PARENT_${params.kind.toUpperCase()}_EVIDENCE`,
      observedAtMs,
      spawnedAtMs: params.classificationParams.spawnedAtMs,
      filePath: rawPath,
    }),
  );

  if (!rawPath) {
    if (params.kind === "log" && evidenceId && evidenceSha256) {
      return reasons.length > 0
        ? { ok: false, reasons }
        : { ok: true, id: evidenceId, sha256: evidenceSha256 };
    }
    reasons.push(`PARENT_${params.kind.toUpperCase()}_PATH_MISSING`);
    return { ok: false, reasons };
  }

  if (pathContainsTraversal(rawPath)) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_PATH_TRAVERSAL:${rawPath}`);
    return { ok: false, reasons };
  }

  const filePath = path.resolve(rawPath);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(filePath);
  } catch {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_PATH_MISSING:${rawPath}`);
    return { ok: false, reasons };
  }
  if (lstat.isSymbolicLink()) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_PATH_SYMLINK_ESCAPE:${rawPath}`);
    return { ok: false, reasons };
  }
  if (!lstat.isFile()) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_PATH_NOT_FILE:${rawPath}`);
    return { ok: false, reasons };
  }
  const realPath = realPathOrResolved(filePath);
  reasons.push(
    ...evidencePathScopeReasons({
      filePath: rawPath,
      realPath,
      scope: params.scope,
      kind: params.kind,
    }),
  );

  const { hash } = fileSha256(filePath);
  if (evidenceSha256 && evidenceSha256 !== hash) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_HASH_STALE:${rawPath}`);
  }
  if (expectedSha256 && expectedSha256 !== hash) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_EXPECTED_HASH_STALE:${rawPath}`);
  }
  const evidenceSize = finiteEvidenceNumber(params.evidence.sizeBytes);
  if (evidenceSize !== undefined && evidenceSize !== lstat.size) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_SIZE_STALE:${rawPath}`);
  }
  const evidenceMtimeMs = finiteEvidenceNumber(params.evidence.mtimeMs);
  if (evidenceMtimeMs !== undefined && Math.abs(evidenceMtimeMs - lstat.mtimeMs) > 1) {
    reasons.push(`PARENT_${params.kind.toUpperCase()}_MTIME_STALE:${rawPath}`);
  }
  reasons.push(
    ...evidenceFreshnessReasons({
      label: `PARENT_${params.kind.toUpperCase()}_EVIDENCE`,
      observedAtMs,
      spawnedAtMs: params.classificationParams.spawnedAtMs,
      mtimeMs: lstat.mtimeMs,
      filePath: rawPath,
    }),
  );
  return reasons.length > 0
    ? { ok: false, reasons }
    : { ok: true, path: rawPath, id: evidenceId, sha256: hash, sizeBytes: lstat.size };
}

function findArtifactEvidence(
  artifact: ChildResultReportedArtifact,
  artifacts: ChildResultParentRuntimeFileEvidence[] | undefined,
): ChildResultParentRuntimeFileEvidence | undefined {
  if (!Array.isArray(artifacts)) {
    return undefined;
  }
  const artifactPath = path.resolve(artifact.path);
  return artifacts.find((entry) => {
    const entryPath = normalizeNonEmptyString(entry.path);
    return entryPath ? path.resolve(entryPath) === artifactPath : false;
  });
}

function findLogEvidenceByPath(
  logPath: string,
  logs: ChildResultParentRuntimeFileEvidence[] | undefined,
): ChildResultParentRuntimeFileEvidence | undefined {
  if (!Array.isArray(logs)) {
    return undefined;
  }
  const resolved = path.resolve(logPath);
  return logs.find((entry) => {
    const entryPath = normalizeNonEmptyString(entry.path);
    return entryPath ? path.resolve(entryPath) === resolved : false;
  });
}

function scopeSafetyReasons(
  report: ParsedChildResultReport,
  scope: ChildResultParentRuntimeScopeEvidence | undefined,
): string[] {
  const reasons: string[] = [];
  if (!scope) {
    reasons.push("PARENT_RUNTIME_SCOPE_EVIDENCE_MISSING");
    return reasons;
  }
  if (!Array.isArray(scope.allowedChangedPaths) || !Array.isArray(scope.allowedSourcePaths)) {
    reasons.push("PARENT_RUNTIME_SCOPE_EVIDENCE_MISSING");
  }
  for (const reportedPath of [...report.changedPaths, ...report.sourcePaths]) {
    if (pathContainsTraversal(reportedPath)) {
      reasons.push(`REPORTED_PATH_TRAVERSAL:${reportedPath}`);
    }
  }
  for (const scopePath of [
    ...normalizeStringArray(scope.allowedChangedPaths),
    ...normalizeStringArray(scope.allowedSourcePaths),
  ]) {
    if (pathContainsTraversal(scopePath)) {
      reasons.push(`PARENT_RUNTIME_SCOPE_PATH_TRAVERSAL:${scopePath}`);
    }
  }
  reasons.push(...scopeDisagreement(report, scope));
  return reasons;
}

function commandEvidenceReasons(command: ChildResultParentRuntimeCommandEvidence): string[] {
  const reasons: string[] = [];
  const label =
    normalizeNonEmptyString(command.commandId ?? command.runId ?? command.command) ?? "unknown";
  if (!normalizeNonEmptyString(command.commandId) && !normalizeNonEmptyString(command.runId)) {
    reasons.push(`PARENT_COMMAND_ID_MISSING:${label}`);
  }
  const status = command.status.trim().toLowerCase();
  if (!CLEAN_GATE_EVIDENCE_STATUSES.has(status)) {
    reasons.push(`PARENT_COMMAND_STATUS_UNVERIFIED:${label}=${command.status.trim()}`);
  }
  if (command.exitCode !== undefined && command.exitCode !== 0) {
    reasons.push(`PARENT_COMMAND_EXIT_NONZERO:${label}=${command.exitCode}`);
  }
  return reasons;
}

function staleProcessSweepReasons(params: {
  sweep: ChildResultParentRuntimeStaleProcessSweepEvidence | undefined;
  evidence: ChildResultParentRuntimeEvidence;
  classificationParams: ChildResultClassificationParams;
}): { reasons: string[]; verifiedLog?: ChildResultLogDebugMetadata } {
  const sweep = params.sweep;
  if (!sweep) {
    return { reasons: ["STALE_PROCESS_SWEEP_MISSING"] };
  }
  const reasons: string[] = [];
  const status = sweep.status.trim().toLowerCase();
  if (!CLEAN_GATE_EVIDENCE_STATUSES.has(status)) {
    reasons.push(`STALE_PROCESS_SWEEP_UNVERIFIED:${sweep.status.trim()}`);
  }
  if (sweep.noRunningProcesses === false) {
    reasons.push("STALE_PROCESS_SWEEP_RUNNING_PROCESSES_REMAIN");
  }
  const observedAtMs = evidenceObservedAtMs(sweep);
  reasons.push(
    ...evidenceFreshnessReasons({
      label: "STALE_PROCESS_SWEEP",
      observedAtMs,
      spawnedAtMs: params.classificationParams.spawnedAtMs,
    }),
  );
  const logPath = normalizeNonEmptyString(sweep.logPath);
  const logSha256 = normalizeHash(sweep.logSha256);
  let verifiedLog: ChildResultLogDebugMetadata | undefined;
  if (logPath || logSha256) {
    if (!logPath || !logSha256) {
      reasons.push("STALE_PROCESS_SWEEP_LOG_EVIDENCE_INCOMPLETE");
    } else {
      const file = verifyParentObservedFileEvidence({
        evidence: {
          logId: sweep.logId,
          path: logPath,
          sha256: logSha256,
          observedAt: sweep.observedAt,
          observedAtMs: sweep.observedAtMs,
          sessionId: sweep.sessionId,
          childRunId: sweep.childRunId,
          childSessionId: sweep.childSessionId,
          childSessionKey: sweep.childSessionKey,
        },
        kind: "log",
        expectedSha256: logSha256,
        scope: params.evidence.scope,
        classificationParams: params.classificationParams,
      });
      if (file.ok) {
        verifiedLog = sanitizeVerifiedLogMetadata({
          logId: sweep.logId,
          path: file.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          status: "verified",
        });
      } else {
        reasons.push(...file.reasons.map((reason) => `STALE_PROCESS_SWEEP_${reason}`));
      }
    }
  }
  return { reasons, ...(verifiedLog ? { verifiedLog } : {}) };
}

export function verifyChildResultParentRuntimeEvidence(params: {
  report: ParsedChildResultReport;
  verifiedArtifacts: ChildResultReportedArtifact[];
  classificationParams: ChildResultClassificationParams;
}): ChildResultEvidenceVerifierDecision {
  const evidence = params.classificationParams.parentRuntimeEvidence;
  const reasons: string[] = [];
  const verifiedCommands: Array<{ commandId?: string; runId?: string; status: string }> = [];
  const verifiedLogs: ChildResultLogDebugMetadata[] = [];
  const verifiedArtifacts: ChildResultArtifactDebugMetadata[] = [];

  if (!evidence) {
    return {
      decision: "EVIDENCE_UNVERIFIED",
      acceptanceEligible: false,
      parentObserved: false,
      reasons: ["PARENT_RUNTIME_EVIDENCE_MISSING"],
    };
  }

  const observedBy = normalizeNonEmptyString(evidence.observedBy);
  const normalizedObserver = observedBy?.toLowerCase();
  const parentObserved = Boolean(
    normalizedObserver && TRUSTED_PARENT_RUNTIME_OBSERVERS.has(normalizedObserver),
  );
  if (!parentObserved) {
    reasons.push(
      normalizedObserver && CHILD_SELF_ATTESTATION_OBSERVERS.has(normalizedObserver)
        ? "PARENT_RUNTIME_EVIDENCE_CHILD_SELF_ATTESTED"
        : "PARENT_RUNTIME_EVIDENCE_NOT_PARENT_OBSERVED",
    );
  }

  reasons.push(
    ...evidenceChildIdentityReasons({
      evidence,
      classificationParams: params.classificationParams,
    }),
  );
  const rootObservedAtMs = evidenceObservedAtMs(evidence);
  reasons.push(
    ...evidenceFreshnessReasons({
      label: "PARENT_RUNTIME_EVIDENCE",
      observedAtMs: rootObservedAtMs,
      spawnedAtMs: params.classificationParams.spawnedAtMs,
    }),
  );

  reasons.push(...scopeSafetyReasons(params.report, evidence.scope));

  for (const artifact of params.verifiedArtifacts) {
    const artifactEvidence = findArtifactEvidence(artifact, evidence.artifacts);
    if (!artifactEvidence) {
      reasons.push(`PARENT_ARTIFACT_EVIDENCE_MISSING:${artifact.path}`);
      continue;
    }
    if (!normalizeNonEmptyString(artifactEvidence.artifactId)) {
      reasons.push(`PARENT_ARTIFACT_ID_MISSING:${artifact.path}`);
    }
    const file = verifyParentObservedFileEvidence({
      evidence: artifactEvidence,
      kind: "artifact",
      expectedSha256: artifact.sha256,
      scope: evidence.scope,
      classificationParams: params.classificationParams,
    });
    if (file.ok) {
      verifiedArtifacts.push(
        sanitizeVerifiedArtifactMetadata(
          {
            artifactId: artifactEvidence.artifactId ?? artifact.artifactId,
            path: artifact.path,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
          },
          "verified",
        ),
      );
    } else {
      reasons.push(...file.reasons);
    }
  }

  if (!Array.isArray(evidence.commands) || evidence.commands.length === 0) {
    reasons.push("PARENT_COMMAND_EVIDENCE_MISSING");
  } else {
    for (const command of evidence.commands) {
      reasons.push(
        ...evidenceChildIdentityReasons({
          evidence: command,
          classificationParams: params.classificationParams,
        }),
      );
      reasons.push(...commandEvidenceReasons(command));
      const logPath = normalizeNonEmptyString(command.logPath);
      const logSha256 = normalizeHash(command.logSha256);
      if (logPath || logSha256 || command.logId) {
        if (!logSha256 && logPath) {
          reasons.push(`PARENT_COMMAND_LOG_HASH_MISSING:${logPath}`);
        } else if (logPath && logSha256) {
          const logEvidence = findLogEvidenceByPath(logPath, evidence.logs) ?? {
            logId: command.logId,
            path: logPath,
            sha256: logSha256,
            observedAt: command.observedAt,
            observedAtMs: command.observedAtMs,
            childRunId: command.childRunId,
            childSessionId: command.childSessionId,
            childSessionKey: command.childSessionKey,
            sessionId: command.sessionId,
          };
          const file = verifyParentObservedFileEvidence({
            evidence: logEvidence,
            kind: "log",
            expectedSha256: logSha256,
            scope: evidence.scope,
            classificationParams: params.classificationParams,
          });
          if (file.ok) {
            verifiedLogs.push(
              sanitizeVerifiedLogMetadata({
                logId: command.logId ?? logEvidence.logId,
                path: file.path,
                sha256: file.sha256,
                sizeBytes: file.sizeBytes,
                status: "verified",
              }),
            );
          } else {
            reasons.push(...file.reasons);
          }
        }
      }
      verifiedCommands.push({
        ...(command.commandId ? { commandId: command.commandId } : {}),
        ...(command.runId ? { runId: command.runId } : {}),
        status: command.status,
      });
    }
  }

  if (Array.isArray(evidence.logs)) {
    for (const logEvidence of evidence.logs) {
      const file = verifyParentObservedFileEvidence({
        evidence: logEvidence,
        kind: "log",
        expectedSha256: logEvidence.sha256,
        scope: evidence.scope,
        classificationParams: params.classificationParams,
      });
      if (file.ok) {
        verifiedLogs.push(
          sanitizeVerifiedLogMetadata({
            logId: logEvidence.logId,
            path: file.path,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            status: "verified",
          }),
        );
      } else {
        reasons.push(...file.reasons);
      }
    }
  }
  if (verifiedLogs.length === 0) {
    reasons.push("PARENT_LOG_EVIDENCE_MISSING");
  }

  const sweep = staleProcessSweepReasons({
    sweep: evidence.staleProcessSweep,
    evidence,
    classificationParams: params.classificationParams,
  });
  reasons.push(...sweep.reasons);
  if (sweep.verifiedLog) {
    verifiedLogs.push(sweep.verifiedLog);
  }

  if (
    !evidence.repoState &&
    (params.report.changedPaths.length > 0 || params.report.sourcePaths.length > 0)
  ) {
    reasons.push("PARENT_REPO_STATE_EVIDENCE_MISSING");
  }
  if (evidence.repoState) {
    const commitId = normalizeNonEmptyString(evidence.repoState.commitId);
    const headCommitId = normalizeNonEmptyString(evidence.repoState.headCommitId);
    if (
      !commitId &&
      !headCommitId &&
      (params.report.changedPaths.length > 0 || params.report.sourcePaths.length > 0)
    ) {
      reasons.push("PARENT_REPO_COMMIT_ID_MISSING");
    }
    if (commitId && headCommitId && commitId !== headCommitId) {
      reasons.push("PARENT_REPO_COMMIT_STALE");
    }
    if (evidence.repoState.dirtyState === "dirty_unverified") {
      reasons.push("PARENT_REPO_DIRTY_STATE_UNVERIFIED");
    }
    if (
      evidence.repoState.worktreeDirty === true &&
      evidence.repoState.dirtyState !== "dirty_allowed"
    ) {
      reasons.push("PARENT_REPO_DIRTY_STATE_UNVERIFIED");
    }
  }

  const uniqueReasons = uniqueStrings(reasons);
  const base = {
    parentObserved,
    ...(observedBy ? { observedBy } : {}),
    ...(evidenceObservedAtText(evidence) ? { observedAt: evidenceObservedAtText(evidence) } : {}),
    ...(evidence.scope ? { scope: evidence.scope } : {}),
    ...(evidence.repoState ? { repoState: evidence.repoState } : {}),
    ...(evidence.staleProcessSweep ? { staleProcessSweep: evidence.staleProcessSweep } : {}),
    ...(verifiedCommands.length > 0 ? { verifiedCommands } : {}),
    ...(verifiedArtifacts.length > 0 ? { verifiedArtifacts } : {}),
    ...(verifiedLogs.length > 0 ? { verifiedLogs } : {}),
  };
  if (uniqueReasons.length > 0) {
    return {
      ...base,
      decision: "EVIDENCE_UNVERIFIED",
      acceptanceEligible: false,
      reasons: uniqueReasons,
    };
  }
  return {
    ...base,
    decision: "VERIFIED_PASS",
    acceptanceEligible: true,
    reasons: ["PARENT_RUNTIME_EVIDENCE_VERIFIED"],
  };
}

function quarantineOptionsFromClassificationParams(params: ChildResultClassificationParams) {
  return {
    quarantineRoot: params.quarantineRoot,
    maxQuarantineBodyChars: params.maxQuarantineBodyChars,
    maxQuarantineArtifactBytes: params.maxQuarantineArtifactBytes,
    maxQuarantineStoreBytes: params.maxQuarantineStoreBytes,
    maxQuarantineStoreCount: params.maxQuarantineStoreCount,
    quarantineTtlDays: params.quarantineTtlDays,
    allowUnsafeQuarantineRoot: params.allowUnsafeQuarantineRoot,
    childSessionKey: params.childSessionKey,
    childRunId: params.childRunId,
    requesterSessionKey: params.requesterSessionKey,
    taskLabel: params.taskLabel,
  };
}

function classifyChildResultContractCore(
  params: ChildResultClassificationParams,
): ChildResultClassification {
  const rawText = params.rawText ?? "";
  const trimmedRawText = rawText.trim();
  const rawSource = params.rawSource ?? "assistant_output";
  const transportOutcome = classifyTransportOutcome(params.outcome);
  const quarantineOptions = quarantineOptionsFromClassificationParams(params);

  if (params.duplicateCompletion === true) {
    const activeTaskValidation =
      params.activeTaskContract !== undefined
        ? normalizeActiveTaskContract(params.activeTaskContract)
        : undefined;
    const childTaskId = params.childTaskId?.trim();
    const activeTaskMismatch = Boolean(
      activeTaskValidation?.ok &&
      childTaskId &&
      childTaskId !== activeTaskValidation.contract.taskId,
    );
    const quarantineArtifact = trimmedRawText
      ? quarantineChildResultOutput({
          rawText,
          source: rawSource,
          reason: CHILD_RESULT_DUPLICATE_COMPLETION,
          classifications: ["DUPLICATE_ANNOUNCE_SUPPRESSED"],
          status: "CANCELLED",
          ...quarantineOptions,
        })
      : undefined;
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_DUPLICATE_COMPLETION,
      acceptanceEligible: false,
      activeTaskContractId: activeTaskValidation?.ok
        ? activeTaskValidation.activeTaskContractId
        : undefined,
      currentTaskOutput: activeTaskValidation?.ok ? !activeTaskMismatch : undefined,
      backgrounded: activeTaskValidation?.ok ? activeTaskMismatch : undefined,
      reasons: activeTaskMismatch
        ? ["DUPLICATE_COMPLETION", "CHILD_TASK_ID_MISMATCH"]
        : ["DUPLICATE_COMPLETION"],
      quarantineArtifact,
    });
  }

  if (!trimmedRawText) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_MISSING_VERDICT_SCHEMA,
      acceptanceEligible: false,
      reasons: ["EMPTY_CHILD_RESULT"],
      labels: ["NO_OUTPUT", "NO_VERDICT"],
      normalizedState:
        transportOutcome === "timeout"
          ? "TIMEOUT"
          : transportOutcome === "cancelled"
            ? "CANCELLED"
            : "MALFORMED",
    });
  }

  const maxQuarantineArtifactBytes = Math.max(
    1,
    params.maxQuarantineArtifactBytes ?? CHILD_RESULT_DEFAULT_MAX_QUARANTINE_ARTIFACT_BYTES,
  );
  if (byteLength(rawText) > maxQuarantineArtifactBytes) {
    return failedQuarantinedClassification({
      rawText,
      source: rawSource,
      verdict: CHILD_RESULT_MISSING_VERDICT_SCHEMA,
      transportOutcome,
      reason: "OVERSIZE_CHILD_RESULT_SUPPRESSED",
      labels: ["OVERSIZE_OUTPUT", "NO_VERDICT"],
      ...quarantineOptions,
    });
  }

  const report = parseChildResultReport(rawText);
  if (!report) {
    if (looksLikeInternalEnvelopeOutput(rawText)) {
      return failedQuarantinedClassification({
        rawText,
        source: rawSource,
        verdict: CHILD_RESULT_MISSING_VERDICT_SCHEMA,
        transportOutcome,
        reason: "INTERNAL_ENVELOPE_OUTPUT_SUPPRESSED",
        labels: ["INTERNAL_ENVELOPE", "NO_VERDICT"],
        ...quarantineOptions,
      });
    }
    if (looksLikeRawDiffOutput(rawText)) {
      return failedQuarantinedClassification({
        rawText,
        source: rawSource,
        verdict: CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT,
        transportOutcome,
        reason: "RAW_DIFF_OUTPUT_SUPPRESSED",
        labels: ["RAW_DIFF_LIKE"],
        ...quarantineOptions,
      });
    }
    if (looksLikeRawGrepOutput(rawText)) {
      return failedQuarantinedClassification({
        rawText,
        source: rawSource,
        verdict: CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT,
        transportOutcome,
        reason: "RAW_GREP_OUTPUT_SUPPRESSED",
        labels: ["RAW_GREP_LIKE"],
        ...quarantineOptions,
      });
    }
    if (looksLikeToolLogOutput(rawText, rawSource)) {
      return failedQuarantinedClassification({
        rawText,
        source: rawSource,
        verdict: CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
        transportOutcome,
        reason: "RAW_TOOL_LOG_OUTPUT_SUPPRESSED",
        labels: ["RAW_LOG_LIKE"],
        ...quarantineOptions,
      });
    }
    if (looksLikeRawSourceOutput(rawText, rawSource)) {
      return failedQuarantinedClassification({
        rawText,
        source: rawSource,
        verdict: CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT,
        transportOutcome,
        reason: "RAW_SOURCE_OUTPUT_SUPPRESSED",
        labels: ["RAW_SOURCE_LIKE"],
        ...quarantineOptions,
      });
    }
    if (looksLikePromptInjection(rawText)) {
      return failedQuarantinedClassification({
        rawText,
        source: rawSource,
        verdict: CHILD_RESULT_MISSING_VERDICT_SCHEMA,
        transportOutcome,
        reason: "PROMPT_INJECTION_OUTPUT_SUPPRESSED",
        labels: ["SCHEMA_INVALID", "NO_VERDICT"],
        ...quarantineOptions,
      });
    }
    const quarantineArtifact = quarantineChildResultOutput({
      rawText,
      source: rawSource,
      reason: CHILD_RESULT_MISSING_VERDICT_SCHEMA,
      classifications: ["NO_VERDICT", "SCHEMA_INVALID"],
      status: "MALFORMED",
      ...quarantineOptions,
    });
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_MISSING_VERDICT_SCHEMA,
      acceptanceEligible: false,
      reasons: ["VERDICT_SCHEMA_MISSING_RAW_BODY_SUPPRESSED"],
      labels: ["NO_VERDICT", "SCHEMA_INVALID"],
      quarantineArtifact,
    });
  }

  if (reportHasFailedGates(report)) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_FAILED_GATES,
      acceptanceEligible: false,
      reasons: ["FAILED_GATES"],
      labels: report.classificationLabels,
      normalizedState: "FAIL",
      parsedReport: report,
    });
  }

  if (reportIsRejected(report)) {
    const infraBlocked = normalizedVerdict(report) === "BLOCKED_INFRA";
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_REJECTED,
      acceptanceEligible: false,
      reasons: [infraBlocked ? "INFRA_BLOCKED_BY_CHILD_VERDICT" : "REJECTED_BY_CHILD_VERDICT"],
      labels: uniqueClassificationLabels([
        ...report.classificationLabels,
        infraBlocked ? "INFRA_BLOCKED" : undefined,
      ]),
      normalizedState: infraBlocked ? "INFRA_BLOCKED" : "FAIL",
      parsedReport: report,
    });
  }

  if (!reportIsPass(report)) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_MISSING_VERDICT_SCHEMA,
      acceptanceEligible: false,
      reasons: ["PASS_OR_REJECT_VERDICT_MISSING"],
      labels: report.classificationLabels.length > 0 ? report.classificationLabels : ["NO_VERDICT"],
      normalizedState: "MALFORMED",
      parsedReport: report,
    });
  }

  if (!report.strictJson && report.outputArtifactPaths.length === 0) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: ["NON_STRICT_RESULT_SCHEMA"],
      labels: uniqueClassificationLabels([...report.classificationLabels, "EVIDENCE_UNVERIFIED"]),
      normalizedState: "UNVERIFIED",
      parsedReport: report,
    });
  }

  const requireActiveTaskContract = params.requireActiveTaskContract !== false;
  let expectedArtifacts = params.expectedOutputArtifacts ?? [];
  let activeTaskContractId: string | undefined;
  if (requireActiveTaskContract) {
    const activeTaskValidation = normalizeActiveTaskContract(params.activeTaskContract);
    if (!activeTaskValidation.ok) {
      return classification({
        transportOutcome,
        contractVerdict:
          activeTaskValidation.contractVerdict === ACTIVE_TASK_CONTRACT_MISSING_VERDICT
            ? CHILD_RESULT_TASK_CONTRACT_MISSING
            : CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        reasons: activeTaskValidation.issues.map((issue) => `${issue.field}:${issue.reason}`),
        parsedReport: report,
      });
    }
    activeTaskContractId = activeTaskValidation.activeTaskContractId;
    const childTaskId = params.childTaskId?.trim() || report.taskId || report.activeTaskContractId;
    if (childTaskId && childTaskId !== activeTaskValidation.contract.taskId) {
      return classification({
        transportOutcome,
        contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
        acceptanceEligible: false,
        activeTaskContractId: activeTaskValidation.activeTaskContractId,
        currentTaskOutput: false,
        backgrounded: true,
        reasons: ["CHILD_TASK_ID_MISMATCH"],
        parsedReport: report,
      });
    }
    expectedArtifacts =
      params.expectedOutputArtifacts ?? activeTaskValidation.contract.expectedOutputArtifacts;
  }

  const artifactVerification = verifyExpectedArtifacts({
    report,
    expectedArtifacts,
    classificationParams: params,
    transportOutcome,
  });
  if (!("ok" in artifactVerification)) {
    return artifactVerification;
  }

  if (!report.strictJson || !report.schemaValid) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: ["NON_STRICT_RESULT_SCHEMA"],
      labels: uniqueClassificationLabels([...report.classificationLabels, "EVIDENCE_UNVERIFIED"]),
      normalizedState: "UNVERIFIED",
      parsedReport: report,
      verifiedArtifacts: artifactVerification.verifiedArtifacts,
    });
  }

  if (parentScopeEvidenceMissing(params.parentScopeCheck)) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: ["PARENT_SCOPE_CHECK_MISSING"],
      parsedReport: report,
      verifiedArtifacts: artifactVerification.verifiedArtifacts,
    });
  }

  const scopeReasons = scopeDisagreement(report, params.parentScopeCheck);
  if (scopeReasons.length > 0) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: scopeReasons,
      parsedReport: report,
      verifiedArtifacts: artifactVerification.verifiedArtifacts,
    });
  }

  const runningGates = runningScopedGates(params.scopedGateProcesses);
  if (runningGates.length > 0) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: [`SCOPED_GATE_PROCESS_STILL_RUNNING:${runningGates.join(",")}`],
      parsedReport: report,
      verifiedArtifacts: artifactVerification.verifiedArtifacts,
    });
  }

  const unverifiedGates = unverifiedScopedGateEvidence(params.scopedGateProcesses);
  if (unverifiedGates.length > 0) {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      reasons: unverifiedGates,
      parsedReport: report,
      verifiedArtifacts: artifactVerification.verifiedArtifacts,
    });
  }

  const evidenceVerifier = verifyChildResultParentRuntimeEvidence({
    report,
    verifiedArtifacts: artifactVerification.verifiedArtifacts,
    classificationParams: params,
  });
  if (evidenceVerifier.decision !== "VERIFIED_PASS") {
    return classification({
      transportOutcome,
      contractVerdict: CHILD_RESULT_EVIDENCE_UNVERIFIED,
      acceptanceEligible: false,
      activeTaskContractId,
      ...(activeTaskContractId ? { currentTaskOutput: true, backgrounded: false } : {}),
      reasons: evidenceVerifier.reasons,
      labels: uniqueClassificationLabels([...report.classificationLabels, "EVIDENCE_UNVERIFIED"]),
      normalizedState: "UNVERIFIED",
      parsedReport: report,
      verifiedArtifacts: artifactVerification.verifiedArtifacts,
      evidenceVerifier,
    });
  }

  return classification({
    transportOutcome,
    contractVerdict: CHILD_RESULT_SCHEMA_VALID,
    acceptanceEligible: true,
    activeTaskContractId,
    ...(activeTaskContractId ? { currentTaskOutput: true, backgrounded: false } : {}),
    reasons: [
      ...(activeTaskContractId ? [`ACTIVE_TASK_CONTRACT_VERIFIED:${activeTaskContractId}`] : []),
      ...evidenceVerifier.reasons,
    ],
    parsedReport: report,
    verifiedArtifacts: artifactVerification.verifiedArtifacts,
    evidenceVerifier,
  });
}

function applyRetryPolicyToClassification(params: {
  classificationResult: ChildResultClassification;
  classificationParams: ChildResultClassificationParams;
}): ChildResultClassification {
  const { classificationResult, classificationParams } = params;
  if (!isMalformedRetryVerdict(classificationResult.contractVerdict)) {
    return classificationResult;
  }

  const currentAttempt: ChildResultRetryAttempt = {
    ...classificationParams.currentRetryAttempt,
    contractVerdict: classificationResult.contractVerdict,
  };
  const retryPolicy = decideChildResultRetryPolicy({
    previousAttempts: [...(classificationParams.previousRetryAttempts ?? []), currentAttempt],
    nextAttempt: classificationParams.nextRetryAttempt ?? classificationParams.currentRetryAttempt,
  });
  const reasons = retryPolicy.directVerificationRequired
    ? uniqueStrings([...classificationResult.reasons, ...retryPolicy.reasons])
    : classificationResult.reasons;

  return classification({
    transportOutcome: classificationResult.transportOutcome,
    contractVerdict: classificationResult.contractVerdict,
    acceptanceEligible: classificationResult.acceptanceEligible,
    reasons,
    labels: classificationResult.classificationLabels,
    normalizedState: classificationResult.normalizedState,
    activeTaskContractId: classificationResult.activeTaskContractId,
    currentTaskOutput: classificationResult.currentTaskOutput,
    backgrounded: classificationResult.backgrounded,
    parsedReport: classificationResult.parsedReport,
    quarantineArtifact: classificationResult.quarantineArtifact,
    verifiedArtifacts: classificationResult.verifiedArtifacts,
    evidenceVerifier: classificationResult.evidenceVerifier,
    retryPolicy,
  });
}

export function classifyChildResultContract(
  params: ChildResultClassificationParams,
): ChildResultClassification {
  return applyRetryPolicyToClassification({
    classificationResult: classifyChildResultContractCore(params),
    classificationParams: params,
  });
}

export function formatChildResultContractSummaryForParent(
  result: ChildResultClassification,
): string {
  const header =
    result.quarantineArtifact !== undefined
      ? "Child result summary (raw body quarantined)"
      : "Child result summary";
  return (
    wrapPromptDataBlock({
      label: header,
      text: result.safeSummary,
    }) || result.safeSummary
  );
}

export function buildParentVisibleChildResult(params: {
  rawText?: string | null;
  rawSource?: ChildResultRawSource;
  outcome?: ChildRunOutcomeLike;
  duplicateCompletion?: boolean;
  activeTaskContract?: unknown;
  childTaskId?: string;
  spawnedAtMs?: number;
  expectedStubCreatedAtMs?: number;
  expectedStubCreatedAtMsByPath?: Record<string, number>;
  expectedOutputArtifacts?: ActiveTaskArtifact[];
  parentPostflightHashes?: Record<string, string>;
  parentScopeCheck?: ChildResultScopeCheck;
  scopedGateProcesses?: ChildResultScopedGateProcess[];
  parentRuntimeEvidence?: ChildResultParentRuntimeEvidence;
  maxVerifiedArtifactBytes?: number;
  quarantineRoot?: string;
  allowUnsafeQuarantineRoot?: boolean;
  childSessionKey?: string;
  childSessionId?: string;
  childRunId?: string;
  requesterSessionKey?: string;
  taskLabel?: string;
  previousRetryAttempts?: ChildResultRetryAttempt[];
  currentRetryAttempt?: Pick<
    ChildResultRetryAttempt,
    "mechanismKey" | "mechanismChanges" | "profileKey" | "promptHash" | "prompt"
  >;
  nextRetryAttempt?: Pick<
    ChildResultRetryAttempt,
    "mechanismKey" | "mechanismChanges" | "profileKey" | "promptHash" | "prompt"
  >;
}): {
  parentVisibleText: string;
  rawBodySuppressed: boolean;
  classification: ChildResultClassification;
  sanitizedMetadata: ChildResultSanitizedMetadata;
} {
  const rawText = params.rawText ?? "";
  const classificationResult = classifyChildResultContract({
    rawText,
    rawSource: params.rawSource,
    outcome: params.outcome,
    duplicateCompletion: params.duplicateCompletion,
    activeTaskContract: params.activeTaskContract,
    childTaskId: params.childTaskId,
    spawnedAtMs: params.spawnedAtMs,
    expectedStubCreatedAtMs: params.expectedStubCreatedAtMs,
    expectedStubCreatedAtMsByPath: params.expectedStubCreatedAtMsByPath,
    expectedOutputArtifacts: params.expectedOutputArtifacts,
    parentPostflightHashes: params.parentPostflightHashes,
    parentScopeCheck: params.parentScopeCheck,
    scopedGateProcesses: params.scopedGateProcesses,
    parentRuntimeEvidence: params.parentRuntimeEvidence,
    maxVerifiedArtifactBytes: params.maxVerifiedArtifactBytes,
    quarantineRoot: params.quarantineRoot,
    allowUnsafeQuarantineRoot: params.allowUnsafeQuarantineRoot,
    childSessionKey: params.childSessionKey,
    childSessionId: params.childSessionId,
    childRunId: params.childRunId,
    requesterSessionKey: params.requesterSessionKey,
    taskLabel: params.taskLabel,
    previousRetryAttempts: params.previousRetryAttempts,
    currentRetryAttempt: params.currentRetryAttempt,
    nextRetryAttempt: params.nextRetryAttempt,
    requireActiveTaskContract: params.activeTaskContract !== undefined,
  });
  if (
    classificationResult.contractVerdict === CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT ||
    classificationResult.contractVerdict === CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT ||
    classificationResult.contractVerdict === CHILD_RESULT_DUPLICATE_COMPLETION ||
    classificationResult.quarantineArtifact ||
    classificationResult.parsedReport
  ) {
    return {
      parentVisibleText: formatChildResultContractSummaryForParent(classificationResult),
      rawBodySuppressed: true,
      classification: classificationResult,
      sanitizedMetadata: classificationResult.sanitizedMetadata,
    };
  }
  if (
    !classificationResult.acceptanceEligible ||
    classificationResult.normalizedState !== "VERIFIED_PASS"
  ) {
    return {
      parentVisibleText: formatChildResultContractSummaryForParent(classificationResult),
      rawBodySuppressed: true,
      classification: classificationResult,
      sanitizedMetadata: classificationResult.sanitizedMetadata,
    };
  }
  return {
    parentVisibleText: formatChildResultContractSummaryForParent(classificationResult),
    rawBodySuppressed: true,
    classification: classificationResult,
    sanitizedMetadata: classificationResult.sanitizedMetadata,
  };
}
