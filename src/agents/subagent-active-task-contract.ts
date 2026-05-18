import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const ACTIVE_TASK_CONTRACT_ENV = "ACTIVE_TASK_CONTRACT" as const;

export const ACTIVE_TASK_CONTRACT_MISSING_VERDICT = "TASK_CONTRACT_MISSING" as const;
export const ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT = "EVIDENCE_UNVERIFIED" as const;
export const ACTIVE_TASK_SCHEMA_VALID_VERDICT = "SCHEMA_VALID" as const;
export const ACTIVE_TASK_PRIORITY_CONFLICT = "TASK_PRIORITY_CONFLICT" as const;
export const SUMMARY_UNVERIFIED = "SUMMARY_UNVERIFIED" as const;
export const ACTIVE_TASK_EXTENDED_CONTRACT_REQUIRED =
  "ACTIVE_TASK_EXTENDED_CONTRACT_REQUIRED" as const;
export const ACTIVE_TASK_CONTRACT_EXPIRED = "ACTIVE_TASK_CONTRACT_EXPIRED" as const;
export const ACTIVE_MEMORY_UNAVAILABLE = "ACTIVE_MEMORY_UNAVAILABLE" as const;
export const ACTIVE_MEMORY_TIMEOUT = "ACTIVE_MEMORY_TIMEOUT" as const;
export const ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS =
  "current_user_request_wins" as const;
export const ACTIVE_TASK_STALE_CONTEXT_ALLOW_IN_SCOPE_BACKGROUND =
  "allow_in_scope_background" as const;
export const ACTIVE_TASK_STALE_CONTEXT_FAIL_CLOSED = "fail_closed" as const;
export const ACTIVE_TASK_MAX_FANOUT_LIMIT = 64 as const;

export type ActiveTaskContractVerdict =
  | typeof ACTIVE_TASK_CONTRACT_MISSING_VERDICT
  | typeof ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT
  | typeof ACTIVE_TASK_SCHEMA_VALID_VERDICT;

export type ActiveTaskArtifact = {
  path: string;
  description?: string;
  sha256?: string;
  schema?: string;
};

export type ActiveTaskArtifactDebugRef = {
  artifactId: string;
  sha256?: string;
  schema?: string;
  status: "expected";
};

export type ActiveTaskAuthorizationSource = {
  kind: string;
  reference?: string;
  sessionKey?: string;
  turnId?: string;
  path?: string;
  sha256?: string;
  description?: string;
};

export type ActiveTaskStaleContextConflictPolicy =
  | typeof ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS
  | typeof ACTIVE_TASK_STALE_CONTEXT_ALLOW_IN_SCOPE_BACKGROUND
  | typeof ACTIVE_TASK_STALE_CONTEXT_FAIL_CLOSED;

export type ActiveTaskContract = {
  contractId?: string;
  taskId: string;
  sessionId?: string;
  createdFromUserTurnId?: string;
  createdAt?: string;
  expiresAt?: string;
  runId?: string;
  authorizationSourcePath?: string;
  authorizationSourceHash?: string;
  authorizedRootIssue?: string;
  allowedAutomationActions?: string[];
  maxFanout?: number;
  staleContextConflictPolicy?: ActiveTaskStaleContextConflictPolicy;
  currentUserRequest: string;
  inputArtifacts: ActiveTaskArtifact[];
  expectedOutputArtifacts: ActiveTaskArtifact[];
  allowedSideEffects: string[];
  authorizationSource: ActiveTaskAuthorizationSource;
  nonGoals: string[];
};

type ActiveTaskArtifactInput = string | Partial<ActiveTaskArtifact>;
type ActiveTaskAuthorizationSourceInput = string | Partial<ActiveTaskAuthorizationSource>;

export type ActiveTaskContractInput = {
  contractId?: unknown;
  taskId?: unknown;
  sessionId?: unknown;
  createdFromUserTurnId?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  runId?: unknown;
  authorizationSourcePath?: unknown;
  authorizationSourceHash?: unknown;
  authorizedRootIssue?: unknown;
  allowedAutomationActions?: unknown;
  maxFanout?: unknown;
  staleContextConflictPolicy?: unknown;
  currentUserRequest?: unknown;
  inputArtifacts?: unknown;
  expectedOutputArtifacts?: unknown;
  allowedSideEffects?: unknown;
  authorizationSource?: unknown;
  nonGoals?: unknown;
};

export type ActiveTaskContractValidationIssue = {
  field: string;
  reason: string;
};

export type ActiveTaskContractValidation =
  | {
      ok: true;
      contract: ActiveTaskContract;
      activeTaskContractId: string;
      issues: [];
    }
  | {
      ok: false;
      contract?: undefined;
      activeTaskContractId?: undefined;
      contractVerdict:
        | typeof ACTIVE_TASK_CONTRACT_MISSING_VERDICT
        | typeof ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT;
      issues: ActiveTaskContractValidationIssue[];
    };

export type ActiveTaskPriorityHint = {
  source: string;
  taskId?: string;
  currentUserRequest?: string;
  activeTaskContractId?: string;
  signal?: string;
  status?: string;
  reasonCode?: string;
  blocker?: boolean;
  inScope?: boolean;
};

export type ActiveTaskBackgroundSignal = {
  source: string;
  backgrounded: boolean;
  authorizing: boolean;
  blocking: boolean;
  inScope: boolean;
  signal?: string;
  ignoredTaskId?: string;
  ignoredCurrentUserRequest?: string;
  ignoredActiveTaskContractId?: string;
};

export type ActiveTaskPriorityConflict = {
  reason: typeof ACTIVE_TASK_PRIORITY_CONFLICT;
  source: string;
  activeTaskContractId: string;
  activeTaskId: string;
  activeCurrentUserRequest: string;
  ignoredTaskId?: string;
  ignoredCurrentUserRequest?: string;
  ignoredActiveTaskContractId?: string;
  signal?: string;
};

export type ActiveTaskChildCompletionClassification = {
  activeTaskContractId?: string;
  contractVerdict: ActiveTaskContractVerdict;
  acceptanceEligible: boolean;
  currentTaskOutput: boolean;
  backgrounded: boolean;
  reasons: string[];
};

export type ActiveTaskChildCompletionDedupeComponents = {
  activeTaskContractId: string;
  childRunId: string;
  childSessionId: string;
  taskId: string;
  resultHash: string;
};

export type ActiveTaskArtifactPostflightEligibility = {
  activeTaskContractId?: string;
  contractVerdict: ActiveTaskContractVerdict;
  acceptanceEligible: boolean;
  expectedOutputArtifact?: ActiveTaskArtifact;
  reasons: string[];
};

export type ActiveTaskExpectedArtifactReservation = {
  path: string;
  artifact: ActiveTaskArtifact;
  reservedAtMs: number;
  freshAfterMs: number;
  existedBeforeReservation: boolean;
  existingSizeBytes?: number;
  existingMtimeMs?: number;
};

export type ActiveTaskExpectedArtifactPreflight =
  | {
      ok: true;
      activeTaskContractId: string;
      reservedAtMs: number;
      expectedOutputArtifacts: ActiveTaskArtifact[];
      reservations: ActiveTaskExpectedArtifactReservation[];
      expectedStubCreatedAtMsByPath: Record<string, number>;
      reasons: [];
    }
  | {
      ok: false;
      activeTaskContractId?: string;
      contractVerdict:
        | typeof ACTIVE_TASK_CONTRACT_MISSING_VERDICT
        | typeof ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT;
      reasons: string[];
    };

export type ActiveTaskExpectedArtifactStubWrite =
  | {
      ok: true;
      activeTaskContractId: string;
      path: string;
      stubCreatedAtMs: number;
      sizeBytes: number;
      sha256: string;
      reasons: [];
    }
  | {
      ok: false;
      activeTaskContractId?: string;
      contractVerdict: ActiveTaskContractVerdict;
      reasons: string[];
    };

export type ActiveTaskStatusCardData = {
  kind: "active_task_contract";
  activeTaskContractId?: string;
  taskId?: string;
  currentUserRequest?: string;
  contractVerdict: ActiveTaskContractVerdict;
  acceptanceEligible: boolean;
  currentTaskOutput: boolean;
  backgrounded: boolean;
  expectedOutputArtifacts?: ActiveTaskArtifactDebugRef[];
  taskPriorityConflicts?: ActiveTaskPriorityConflict[];
  backgroundSignals?: ActiveTaskBackgroundSignal[];
  reasons: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeArtifactPath(value: string): string {
  return value.trim();
}

function cloneArtifact(artifact: ActiveTaskArtifact): ActiveTaskArtifact {
  return { ...artifact };
}

function activeTaskArtifactDebugId(artifact: ActiveTaskArtifact): string {
  const stableSource = artifact.sha256 || artifact.path;
  return `artifact_${createHash("sha256").update(stableSource).digest("hex").slice(0, 16)}`;
}

function buildActiveTaskArtifactDebugRef(artifact: ActiveTaskArtifact): ActiveTaskArtifactDebugRef {
  return {
    artifactId: activeTaskArtifactDebugId(artifact),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.schema ? { schema: artifact.schema } : {}),
    status: "expected",
  };
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  issues: ActiveTaskContractValidationIssue[],
): string {
  const normalized = normalizeString(record[field]);
  if (!normalized) {
    issues.push({ field, reason: "required_non_empty_string" });
    return "";
  }
  return normalized;
}

function normalizeStringArray(
  value: unknown,
  field: string,
  issues: ActiveTaskContractValidationIssue[],
): string[] {
  if (!Array.isArray(value)) {
    issues.push({ field, reason: "required_array" });
    return [];
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const normalized = normalizeString(item);
    if (!normalized) {
      issues.push({ field: `${field}[${index}]`, reason: "required_non_empty_string" });
      continue;
    }
    result.push(normalized);
  }
  return result;
}

function normalizeArtifact(
  value: ActiveTaskArtifactInput,
  field: string,
  issues: ActiveTaskContractValidationIssue[],
): ActiveTaskArtifact | undefined {
  const rawArtifact = typeof value === "string" ? { path: value } : value;
  if (!isRecord(rawArtifact)) {
    issues.push({ field, reason: "required_artifact_path" });
    return undefined;
  }
  const path = normalizeString(rawArtifact.path);
  if (!path) {
    issues.push({ field: `${field}.path`, reason: "required_non_empty_string" });
    return undefined;
  }
  const artifact: ActiveTaskArtifact = { path: normalizeArtifactPath(path) };
  const description = normalizeString(rawArtifact.description);
  if (description) {
    artifact.description = description;
  }
  const sha256 = normalizeString(rawArtifact.sha256);
  if (sha256) {
    artifact.sha256 = sha256;
  }
  const schema = normalizeString(rawArtifact.schema);
  if (schema) {
    artifact.schema = schema;
  }
  return artifact;
}

function normalizeArtifactArray(
  value: unknown,
  field: string,
  issues: ActiveTaskContractValidationIssue[],
): ActiveTaskArtifact[] {
  if (!Array.isArray(value)) {
    issues.push({ field, reason: "required_array" });
    return [];
  }
  const result: ActiveTaskArtifact[] = [];
  for (const [index, item] of value.entries()) {
    const artifact = normalizeArtifact(
      item as ActiveTaskArtifactInput,
      `${field}[${index}]`,
      issues,
    );
    if (artifact) {
      result.push(artifact);
    }
  }
  return result;
}

function normalizeAuthorizationSource(
  value: ActiveTaskAuthorizationSourceInput,
  issues: ActiveTaskContractValidationIssue[],
): ActiveTaskAuthorizationSource | undefined {
  if (typeof value === "string") {
    const reference = normalizeString(value);
    if (!reference) {
      issues.push({ field: "authorizationSource", reason: "required_non_empty_string" });
      return undefined;
    }
    return { kind: "reference", reference };
  }
  if (!isRecord(value)) {
    issues.push({ field: "authorizationSource", reason: "required_authorization_source" });
    return undefined;
  }
  const kind = normalizeString(value.kind);
  if (!kind) {
    issues.push({ field: "authorizationSource.kind", reason: "required_non_empty_string" });
    return undefined;
  }
  const source: ActiveTaskAuthorizationSource = { kind };
  for (const key of [
    "reference",
    "sessionKey",
    "turnId",
    "path",
    "sha256",
    "description",
  ] as const) {
    const normalized = normalizeString(value[key]);
    if (normalized) {
      source[key] = normalized;
    }
  }
  return source;
}

const EXTENDED_ACTIVE_TASK_CONTRACT_FIELDS = [
  "contractId",
  "sessionId",
  "createdFromUserTurnId",
  "createdAt",
  "expiresAt",
  "runId",
  "authorizationSourcePath",
  "authorizationSourceHash",
  "authorizedRootIssue",
  "allowedAutomationActions",
  "maxFanout",
  "staleContextConflictPolicy",
] as const;

type ExtendedActiveTaskContractPatch = Pick<
  ActiveTaskContract,
  | "contractId"
  | "sessionId"
  | "createdFromUserTurnId"
  | "createdAt"
  | "expiresAt"
  | "runId"
  | "authorizationSourcePath"
  | "authorizationSourceHash"
  | "authorizedRootIssue"
  | "allowedAutomationActions"
  | "maxFanout"
  | "staleContextConflictPolicy"
>;

function hasAnyExtendedActiveTaskContractField(record: Record<string, unknown>): boolean {
  return EXTENDED_ACTIVE_TASK_CONTRACT_FIELDS.some((field) => record[field] !== undefined);
}

function normalizeTimestampString(
  value: unknown,
  field: string,
  issues: ActiveTaskContractValidationIssue[],
  required: boolean,
): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    if (required) {
      issues.push({ field, reason: "required_non_empty_string" });
    }
    return undefined;
  }
  if (!Number.isFinite(Date.parse(normalized))) {
    issues.push({ field, reason: "required_valid_timestamp" });
    return undefined;
  }
  return normalized;
}

function normalizeNonNegativeInteger(
  value: unknown,
  field: string,
  issues: ActiveTaskContractValidationIssue[],
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    issues.push({ field, reason: "required_non_negative_integer" });
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized > ACTIVE_TASK_MAX_FANOUT_LIMIT) {
    issues.push({ field, reason: `max_${ACTIVE_TASK_MAX_FANOUT_LIMIT}` });
    return undefined;
  }
  return normalized;
}

function normalizeStaleContextConflictPolicy(
  value: unknown,
  issues: ActiveTaskContractValidationIssue[],
): ActiveTaskStaleContextConflictPolicy | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    issues.push({ field: "staleContextConflictPolicy", reason: "required_non_empty_string" });
    return undefined;
  }
  if (
    normalized !== ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS &&
    normalized !== ACTIVE_TASK_STALE_CONTEXT_ALLOW_IN_SCOPE_BACKGROUND &&
    normalized !== ACTIVE_TASK_STALE_CONTEXT_FAIL_CLOSED
  ) {
    issues.push({ field: "staleContextConflictPolicy", reason: "unsupported_policy" });
    return undefined;
  }
  return normalized;
}

function normalizeExtendedActiveTaskContractFields(
  record: Record<string, unknown>,
  issues: ActiveTaskContractValidationIssue[],
): Partial<ExtendedActiveTaskContractPatch> {
  if (!hasAnyExtendedActiveTaskContractField(record)) {
    return {};
  }

  const contractId = readRequiredString(record, "contractId", issues);
  const sessionId = readRequiredString(record, "sessionId", issues);
  const createdFromUserTurnId = readRequiredString(record, "createdFromUserTurnId", issues);
  const createdAt = normalizeTimestampString(record.createdAt, "createdAt", issues, true);
  const expiresAt = normalizeTimestampString(record.expiresAt, "expiresAt", issues, false);
  const runId = normalizeString(record.runId);
  if (!expiresAt && !runId) {
    issues.push({ field: "expiresAt", reason: "required_bounded_expires_at_or_run_id" });
  }
  const authorizationSourcePath = readRequiredString(record, "authorizationSourcePath", issues);
  const authorizationSourceHash = readRequiredString(record, "authorizationSourceHash", issues);
  const authorizedRootIssue = readRequiredString(record, "authorizedRootIssue", issues);
  const allowedAutomationActions = normalizeStringArray(
    record.allowedAutomationActions,
    "allowedAutomationActions",
    issues,
  );
  const maxFanout = normalizeNonNegativeInteger(record.maxFanout, "maxFanout", issues);
  const staleContextConflictPolicy = normalizeStaleContextConflictPolicy(
    record.staleContextConflictPolicy,
    issues,
  );

  return {
    ...(contractId ? { contractId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(createdFromUserTurnId ? { createdFromUserTurnId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(runId ? { runId } : {}),
    ...(authorizationSourcePath ? { authorizationSourcePath } : {}),
    ...(authorizationSourceHash ? { authorizationSourceHash } : {}),
    ...(authorizedRootIssue ? { authorizedRootIssue } : {}),
    allowedAutomationActions,
    ...(maxFanout !== undefined ? { maxFanout } : {}),
    ...(staleContextConflictPolicy ? { staleContextConflictPolicy } : {}),
  };
}

function validationFailure(
  contractVerdict:
    | typeof ACTIVE_TASK_CONTRACT_MISSING_VERDICT
    | typeof ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
  issues: ActiveTaskContractValidationIssue[],
): ActiveTaskContractValidation {
  return { ok: false, contractVerdict, issues };
}

export function deriveActiveTaskContractId(contract: ActiveTaskContract): string {
  return contract.contractId ?? contract.taskId;
}

export function normalizeActiveTaskContract(value: unknown): ActiveTaskContractValidation {
  if (value == null || value === "") {
    return validationFailure(ACTIVE_TASK_CONTRACT_MISSING_VERDICT, [
      { field: "ACTIVE_TASK_CONTRACT", reason: "missing" },
    ]);
  }
  if (!isRecord(value)) {
    return validationFailure(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT, [
      { field: "ACTIVE_TASK_CONTRACT", reason: "required_object" },
    ]);
  }

  const issues: ActiveTaskContractValidationIssue[] = [];
  const taskId = readRequiredString(value, "taskId", issues);
  const currentUserRequest = readRequiredString(value, "currentUserRequest", issues);
  const inputArtifacts = normalizeArtifactArray(value.inputArtifacts, "inputArtifacts", issues);
  const expectedOutputArtifacts = normalizeArtifactArray(
    value.expectedOutputArtifacts,
    "expectedOutputArtifacts",
    issues,
  );
  const allowedSideEffects = normalizeStringArray(
    value.allowedSideEffects,
    "allowedSideEffects",
    issues,
  );
  const authorizationSource = normalizeAuthorizationSource(
    value.authorizationSource as ActiveTaskAuthorizationSourceInput,
    issues,
  );
  const nonGoals = normalizeStringArray(value.nonGoals, "nonGoals", issues);
  const extendedFields = normalizeExtendedActiveTaskContractFields(value, issues);

  if (issues.length > 0 || !authorizationSource) {
    return validationFailure(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT, issues);
  }

  const contract: ActiveTaskContract = {
    ...extendedFields,
    taskId,
    currentUserRequest,
    inputArtifacts,
    expectedOutputArtifacts,
    allowedSideEffects,
    authorizationSource,
    nonGoals,
  };
  return {
    ok: true,
    contract,
    activeTaskContractId: deriveActiveTaskContractId(contract),
    issues: [],
  };
}

export function createActiveTaskContract(
  value: ActiveTaskContractInput,
): ActiveTaskContractValidation {
  return normalizeActiveTaskContract(value);
}

export function readActiveTaskContractFromEnv(
  env: Partial<Pick<NodeJS.ProcessEnv, typeof ACTIVE_TASK_CONTRACT_ENV>> = process.env,
): ActiveTaskContractValidation {
  const raw = env.ACTIVE_TASK_CONTRACT?.trim();
  if (!raw) {
    return validationFailure(ACTIVE_TASK_CONTRACT_MISSING_VERDICT, [
      { field: ACTIVE_TASK_CONTRACT_ENV, reason: "missing" },
    ]);
  }
  try {
    return normalizeActiveTaskContract(JSON.parse(raw));
  } catch {
    return validationFailure(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT, [
      { field: ACTIVE_TASK_CONTRACT_ENV, reason: "invalid_json" },
    ]);
  }
}

function missingExtendedContractFields(
  contract: ActiveTaskContract,
): ActiveTaskContractValidationIssue[] {
  const issues: ActiveTaskContractValidationIssue[] = [];
  const requireString = (field: keyof ActiveTaskContract) => {
    if (!normalizeString(contract[field])) {
      issues.push({ field, reason: "required_for_acceptance" });
    }
  };
  requireString("contractId");
  requireString("sessionId");
  requireString("createdFromUserTurnId");
  requireString("createdAt");
  requireString("authorizationSourcePath");
  requireString("authorizationSourceHash");
  requireString("authorizedRootIssue");
  requireString("staleContextConflictPolicy");
  if (!contract.expiresAt && !contract.runId) {
    issues.push({ field: "expiresAt", reason: "required_bounded_expires_at_or_run_id" });
  }
  if (!Array.isArray(contract.allowedAutomationActions)) {
    issues.push({ field: "allowedAutomationActions", reason: "required_for_acceptance" });
  }
  if (typeof contract.maxFanout !== "number" || !Number.isFinite(contract.maxFanout)) {
    issues.push({ field: "maxFanout", reason: "required_for_acceptance" });
  }
  return issues;
}

function extendedContractFreshnessIssues(
  contract: ActiveTaskContract,
  nowMs = Date.now(),
): ActiveTaskContractValidationIssue[] {
  const issues: ActiveTaskContractValidationIssue[] = [];
  const createdAt = contract.createdAt ? Date.parse(contract.createdAt) : Number.NaN;
  if (contract.createdAt && !Number.isFinite(createdAt)) {
    issues.push({ field: "createdAt", reason: "required_valid_timestamp" });
  }
  if (contract.expiresAt) {
    const expiresAt = Date.parse(contract.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      issues.push({ field: "expiresAt", reason: "required_valid_timestamp" });
    } else if (expiresAt <= nowMs) {
      issues.push({ field: "expiresAt", reason: "expired" });
    }
  }
  return issues;
}

export function validateActiveTaskContractForAcceptance(params: {
  activeTaskContract?: unknown;
  nowMs?: number;
}):
  | {
      ok: true;
      contract: ActiveTaskContract;
      activeTaskContractId: string;
      issues: [];
    }
  | {
      ok: false;
      activeTaskContractId?: string;
      contractVerdict:
        | typeof ACTIVE_TASK_CONTRACT_MISSING_VERDICT
        | typeof ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT;
      issues: ActiveTaskContractValidationIssue[];
    } {
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  if (!validation.ok) {
    return validation;
  }
  const issues = [
    ...missingExtendedContractFields(validation.contract),
    ...extendedContractFreshnessIssues(validation.contract, params.nowMs),
  ];
  if (issues.length > 0) {
    return {
      ok: false,
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
      issues,
    };
  }
  return validation;
}

function formatAcceptanceContractIssue(issue: ActiveTaskContractValidationIssue): string {
  if (issue.reason === "expired") {
    return `${ACTIVE_TASK_CONTRACT_EXPIRED}:${issue.field}`;
  }
  return `${ACTIVE_TASK_EXTENDED_CONTRACT_REQUIRED}:${issue.field}:${issue.reason}`;
}

function sha256Buffer(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashActiveTaskChildCompletionResult(resultText: string | null | undefined): string {
  return sha256Buffer(resultText?.trim() ?? "");
}

function duplicateExpectedArtifactPaths(contract: ActiveTaskContract): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const artifact of contract.expectedOutputArtifacts) {
    if (seen.has(artifact.path)) {
      duplicates.add(artifact.path);
      continue;
    }
    seen.add(artifact.path);
  }
  return [...duplicates];
}

function ensureParentDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  if (directory && directory !== ".") {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function preflightActiveTaskExpectedOutputArtifacts(params: {
  activeTaskContract?: unknown;
  nowMs?: number;
  createParentDirectories?: boolean;
}): ActiveTaskExpectedArtifactPreflight {
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  if (!validation.ok) {
    return {
      contractVerdict: validation.contractVerdict,
      ok: false,
      reasons: validation.issues.map((issue) => `${issue.field}:${issue.reason}`),
    };
  }

  const duplicates = duplicateExpectedArtifactPaths(validation.contract);
  if (duplicates.length > 0) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
      ok: false,
      reasons: [`DUPLICATE_EXPECTED_OUTPUT_ARTIFACT_PATH:${duplicates.join(",")}`],
    };
  }

  const acceptanceContract = validateActiveTaskContractForAcceptance({
    activeTaskContract: validation.contract,
    nowMs: params.nowMs,
  });
  if (!acceptanceContract.ok) {
    return {
      activeTaskContractId: acceptanceContract.activeTaskContractId,
      contractVerdict: acceptanceContract.contractVerdict,
      ok: false,
      reasons: acceptanceContract.issues.map(formatAcceptanceContractIssue),
    };
  }

  const reservedAtMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs)
      ? Math.max(0, params.nowMs)
      : Date.now();
  const reservations: ActiveTaskExpectedArtifactReservation[] = [];
  for (const artifact of validation.contract.expectedOutputArtifacts) {
    if (params.createParentDirectories !== false) {
      ensureParentDirectory(artifact.path);
    }
    let existingSizeBytes: number | undefined;
    let existingMtimeMs: number | undefined;
    let existedBeforeReservation = false;
    try {
      const stat = fs.statSync(artifact.path);
      existedBeforeReservation = true;
      existingSizeBytes = stat.size;
      existingMtimeMs = stat.mtimeMs;
    } catch (err) {
      if (!err || (err as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          activeTaskContractId: validation.activeTaskContractId,
          contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
          ok: false,
          reasons: [`EXPECTED_OUTPUT_ARTIFACT_PREFLIGHT_FAILED:${artifact.path}`],
        };
      }
    }
    reservations.push({
      artifact: cloneArtifact(artifact),
      path: artifact.path,
      reservedAtMs,
      freshAfterMs: reservedAtMs,
      existedBeforeReservation,
      ...(existingSizeBytes !== undefined ? { existingSizeBytes } : {}),
      ...(existingMtimeMs !== undefined ? { existingMtimeMs } : {}),
    });
  }

  return {
    activeTaskContractId: validation.activeTaskContractId,
    expectedOutputArtifacts: validation.contract.expectedOutputArtifacts.map(cloneArtifact),
    expectedStubCreatedAtMsByPath: {},
    ok: true,
    reasons: [],
    reservations,
    reservedAtMs,
  };
}

export function writeActiveTaskExpectedOutputArtifactStub(params: {
  activeTaskContract?: unknown;
  outputArtifactPath: string;
  nowMs?: number;
  content?: string | Record<string, unknown>;
}): ActiveTaskExpectedArtifactStubWrite {
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  if (!validation.ok) {
    return {
      contractVerdict: validation.contractVerdict,
      ok: false,
      reasons: validation.issues.map((issue) => `${issue.field}:${issue.reason}`),
    };
  }

  const eligibility = evaluateActiveTaskArtifactPostflightEligibility({
    activeTaskContract: validation.contract,
    outputArtifactPath: params.outputArtifactPath,
  });
  if (!eligibility.acceptanceEligible) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: eligibility.contractVerdict,
      ok: false,
      reasons: eligibility.reasons,
    };
  }

  const normalizedPath = normalizeArtifactPath(params.outputArtifactPath);
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs)
      ? Math.max(0, params.nowMs)
      : Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const content =
    typeof params.content === "string"
      ? params.content
      : `${JSON.stringify(
          params.content ?? {
            kind: "active_task_expected_output_stub",
            activeTaskContractId: validation.activeTaskContractId,
            path: normalizedPath,
            verdict: "PENDING",
            contractVerdict: "PENDING",
            stub: true,
            createdAt,
          },
          null,
          2,
        )}
`;

  try {
    ensureParentDirectory(normalizedPath);
    fs.writeFileSync(normalizedPath, content, { encoding: "utf8", mode: 0o600 });
    const stat = fs.statSync(normalizedPath);
    return {
      activeTaskContractId: validation.activeTaskContractId,
      ok: true,
      path: normalizedPath,
      reasons: [],
      sha256: sha256Buffer(content),
      sizeBytes: stat.size,
      stubCreatedAtMs: stat.mtimeMs,
    };
  } catch {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
      ok: false,
      reasons: [`EXPECTED_OUTPUT_ARTIFACT_STUB_WRITE_FAILED:${normalizedPath}`],
    };
  }
}

export function isExpectedOutputArtifactPath(
  contract: ActiveTaskContract,
  outputArtifactPath: string,
): boolean {
  const normalized = normalizeArtifactPath(outputArtifactPath);
  return contract.expectedOutputArtifacts.some((artifact) => artifact.path === normalized);
}

export function evaluateActiveTaskArtifactPostflightEligibility(params: {
  activeTaskContract?: unknown;
  outputArtifactPath?: string;
}): ActiveTaskArtifactPostflightEligibility {
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  if (!validation.ok) {
    return {
      contractVerdict: validation.contractVerdict,
      acceptanceEligible: false,
      reasons: validation.issues.map((issue) => issue.reason),
    };
  }

  const outputArtifactPath = normalizeString(params.outputArtifactPath);
  if (!outputArtifactPath) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
      acceptanceEligible: false,
      reasons: ["OUTPUT_ARTIFACT_PATH_MISSING"],
    };
  }

  const normalizedPath = normalizeArtifactPath(outputArtifactPath);
  const expected = validation.contract.expectedOutputArtifacts.find(
    (artifact) => artifact.path === normalizedPath,
  );
  if (!expected) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
      acceptanceEligible: false,
      reasons: ["OUTPUT_ARTIFACT_NOT_CONTRACTED"],
    };
  }

  const acceptanceContract = validateActiveTaskContractForAcceptance({
    activeTaskContract: validation.contract,
  });
  if (!acceptanceContract.ok) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: acceptanceContract.contractVerdict,
      acceptanceEligible: false,
      reasons: acceptanceContract.issues.map(formatAcceptanceContractIssue),
    };
  }

  return {
    activeTaskContractId: validation.activeTaskContractId,
    contractVerdict: ACTIVE_TASK_SCHEMA_VALID_VERDICT,
    acceptanceEligible: true,
    expectedOutputArtifact: cloneArtifact(expected),
    reasons: [],
  };
}

export function classifyChildCompletionAgainstActiveTask(params: {
  activeTaskContract?: unknown;
  childTaskId?: string;
  outputArtifactPaths?: string[];
}): ActiveTaskChildCompletionClassification {
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  if (!validation.ok) {
    return {
      contractVerdict: validation.contractVerdict,
      acceptanceEligible: false,
      currentTaskOutput: false,
      backgrounded: false,
      reasons: validation.issues.map((issue) => issue.reason),
    };
  }

  const childTaskId = normalizeString(params.childTaskId);
  if (childTaskId && childTaskId !== validation.contract.taskId) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
      acceptanceEligible: false,
      currentTaskOutput: false,
      backgrounded: true,
      reasons: ["CHILD_TASK_ID_MISMATCH"],
    };
  }

  const outputArtifactPaths = params.outputArtifactPaths;
  if (
    validation.contract.expectedOutputArtifacts.length > 0 &&
    (!Array.isArray(outputArtifactPaths) || outputArtifactPaths.length === 0)
  ) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
      acceptanceEligible: false,
      currentTaskOutput: true,
      backgrounded: false,
      reasons: ["EXPECTED_OUTPUT_ARTIFACTS_UNVERIFIED"],
    };
  }

  for (const outputArtifactPath of outputArtifactPaths ?? []) {
    const eligibility = evaluateActiveTaskArtifactPostflightEligibility({
      activeTaskContract: validation.contract,
      outputArtifactPath,
    });
    if (!eligibility.acceptanceEligible) {
      return {
        activeTaskContractId: validation.activeTaskContractId,
        contractVerdict: eligibility.contractVerdict,
        acceptanceEligible: false,
        currentTaskOutput: true,
        backgrounded: false,
        reasons: eligibility.reasons,
      };
    }
  }

  const acceptanceContract = validateActiveTaskContractForAcceptance({
    activeTaskContract: validation.contract,
  });
  if (!acceptanceContract.ok) {
    return {
      activeTaskContractId: validation.activeTaskContractId,
      contractVerdict: acceptanceContract.contractVerdict,
      acceptanceEligible: false,
      currentTaskOutput: true,
      backgrounded: false,
      reasons: acceptanceContract.issues.map(formatAcceptanceContractIssue),
    };
  }

  return {
    activeTaskContractId: validation.activeTaskContractId,
    contractVerdict: ACTIVE_TASK_SCHEMA_VALID_VERDICT,
    acceptanceEligible: true,
    currentTaskOutput: true,
    backgrounded: false,
    reasons: [],
  };
}

export function activeMemoryLookupSignalToPriorityHint(params: {
  status?: string;
  taskId?: string;
  currentUserRequest?: string;
  activeTaskContractId?: string;
  source?: string;
}): ActiveTaskPriorityHint | undefined {
  const status = normalizeString(params.status)?.toLowerCase();
  if (!status) {
    return undefined;
  }
  const signal =
    status === "timeout" || status === "timeout_partial"
      ? ACTIVE_MEMORY_TIMEOUT
      : status === "unavailable" || status === "failed"
        ? ACTIVE_MEMORY_UNAVAILABLE
        : undefined;
  if (!signal) {
    return undefined;
  }
  const taskId = normalizeString(params.taskId);
  const currentUserRequest = normalizeString(params.currentUserRequest);
  const activeTaskContractId = normalizeString(params.activeTaskContractId);
  return {
    source: normalizeString(params.source) ?? "active-memory",
    signal,
    ...(taskId ? { taskId } : {}),
    ...(currentUserRequest ? { currentUserRequest } : {}),
    ...(activeTaskContractId ? { activeTaskContractId } : {}),
  };
}

function normalizeHintSignal(hint: ActiveTaskPriorityHint): string | undefined {
  return normalizeString(hint.signal ?? hint.reasonCode ?? hint.status);
}

function actionAllowsBackgroundHintSource(action: string, source: string): boolean {
  const normalizedAction = action.trim().toLowerCase();
  const normalizedSource = source.trim().toLowerCase();
  return (
    normalizedAction === "background_hint:*" ||
    normalizedAction === "use_background_hint:*" ||
    normalizedAction === `background_hint:${normalizedSource}` ||
    normalizedAction === `use_background_hint:${normalizedSource}` ||
    normalizedAction === `background:${normalizedSource}` ||
    normalizedAction === `plugin:${normalizedSource}` ||
    (normalizedSource === "active-memory" && normalizedAction === "use_active_memory")
  );
}

function isBackgroundHintInScope(contract: ActiveTaskContract, source: string): boolean {
  if (contract.staleContextConflictPolicy !== ACTIVE_TASK_STALE_CONTEXT_ALLOW_IN_SCOPE_BACKGROUND) {
    return false;
  }
  return (contract.allowedAutomationActions ?? []).some((action) =>
    actionAllowsBackgroundHintSource(action, source),
  );
}

export function resolveActiveTaskCurrentRequest(params: {
  activeTaskContract?: unknown;
  backgroundHints?: ActiveTaskPriorityHint[];
}):
  | {
      ok: true;
      activeTaskContractId: string;
      currentUserRequest: string;
      taskPriorityConflicts: ActiveTaskPriorityConflict[];
      backgroundSignals: ActiveTaskBackgroundSignal[];
    }
  | {
      ok: false;
      contractVerdict:
        | typeof ACTIVE_TASK_CONTRACT_MISSING_VERDICT
        | typeof ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT;
      issues: ActiveTaskContractValidationIssue[];
    } {
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  if (!validation.ok) {
    return {
      ok: false,
      contractVerdict: validation.contractVerdict,
      issues: validation.issues,
    };
  }

  const conflicts: ActiveTaskPriorityConflict[] = [];
  const backgroundSignals: ActiveTaskBackgroundSignal[] = [];
  for (const hint of params.backgroundHints ?? []) {
    const source = normalizeString(hint.source) ?? "background";
    const hintedTaskId = normalizeString(hint.taskId);
    const hintedRequest = normalizeString(hint.currentUserRequest);
    const hintedContractId = normalizeString(hint.activeTaskContractId);
    const signal = normalizeHintSignal(hint);
    const inScope = isBackgroundHintInScope(validation.contract, source);
    const taskDiffers = Boolean(hintedTaskId && hintedTaskId !== validation.contract.taskId);
    const requestDiffers = Boolean(
      hintedRequest && hintedRequest !== validation.contract.currentUserRequest,
    );
    const contractDiffers = Boolean(
      hintedContractId && hintedContractId !== validation.activeTaskContractId,
    );
    const lookupUnavailable =
      signal === ACTIVE_MEMORY_UNAVAILABLE || signal === ACTIVE_MEMORY_TIMEOUT;
    const backgrounded =
      !inScope || taskDiffers || requestDiffers || contractDiffers || lookupUnavailable;
    const blocking = Boolean(hint.blocker && !backgrounded && inScope && !lookupUnavailable);
    if (backgrounded || signal || hint.blocker) {
      backgroundSignals.push({
        source,
        backgrounded,
        authorizing: !backgrounded && !lookupUnavailable,
        blocking,
        inScope,
        ...(signal ? { signal } : {}),
        ...(hintedTaskId ? { ignoredTaskId: hintedTaskId } : {}),
        ...(hintedRequest ? { ignoredCurrentUserRequest: hintedRequest } : {}),
        ...(hintedContractId ? { ignoredActiveTaskContractId: hintedContractId } : {}),
      });
    }
    if (!taskDiffers && !requestDiffers && !contractDiffers) {
      continue;
    }
    conflicts.push({
      reason: ACTIVE_TASK_PRIORITY_CONFLICT,
      source,
      activeTaskContractId: validation.activeTaskContractId,
      activeTaskId: validation.contract.taskId,
      activeCurrentUserRequest: validation.contract.currentUserRequest,
      ...(hintedTaskId ? { ignoredTaskId: hintedTaskId } : {}),
      ...(hintedRequest ? { ignoredCurrentUserRequest: hintedRequest } : {}),
      ...(hintedContractId ? { ignoredActiveTaskContractId: hintedContractId } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  return {
    ok: true,
    activeTaskContractId: validation.activeTaskContractId,
    currentUserRequest: validation.contract.currentUserRequest,
    taskPriorityConflicts: conflicts,
    backgroundSignals,
  };
}

function keyPart(value: string | undefined, fallback = "none"): string {
  const normalized = normalizeString(value) ?? fallback;
  return encodeURIComponent(normalized);
}

export function buildActiveTaskChildCompletionDedupeKey(params: {
  activeTaskContract?: unknown;
  activeTaskContractId?: string;
  childRunId?: string;
  childSessionId?: string;
  childSessionKey?: string;
  childTaskId?: string;
  taskId?: string;
  resultHash?: string;
}): ActiveTaskChildCompletionClassification & {
  key: string;
  childSessionId?: string;
  resultHash?: string;
  taskId?: string;
  components: ActiveTaskChildCompletionDedupeComponents;
} {
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  const taskId =
    normalizeString(params.taskId ?? params.childTaskId) ??
    (validation.ok ? validation.contract.taskId : undefined);
  const classification = classifyChildCompletionAgainstActiveTask({
    activeTaskContract: validation.ok ? validation.contract : params.activeTaskContract,
    childTaskId: taskId,
  });
  const contractKey =
    classification.activeTaskContractId ??
    normalizeString(params.activeTaskContractId) ??
    classification.contractVerdict;
  const childRunId = normalizeString(params.childRunId) ?? "none";
  const childSessionId =
    normalizeString(params.childSessionId) ?? normalizeString(params.childSessionKey) ?? "none";
  const resultHash = normalizeString(params.resultHash) ?? hashActiveTaskChildCompletionResult("");
  const components: ActiveTaskChildCompletionDedupeComponents = {
    activeTaskContractId: contractKey,
    childRunId,
    childSessionId,
    taskId: taskId ?? "none",
    resultHash,
  };
  return {
    ...classification,
    childSessionId,
    resultHash,
    ...(taskId ? { taskId } : {}),
    components,
    key: [
      `activeTaskContractId=${keyPart(components.activeTaskContractId)}`,
      `childRunId=${keyPart(components.childRunId)}`,
      `childSessionId=${keyPart(components.childSessionId)}`,
      `taskId=${keyPart(components.taskId)}`,
      `resultHash=${keyPart(components.resultHash)}`,
    ].join("|"),
  };
}

export function buildActiveTaskStatusCardData(params: {
  activeTaskContract?: unknown;
  childTaskId?: string;
  outputArtifactPaths?: string[];
  backgroundHints?: ActiveTaskPriorityHint[];
}): ActiveTaskStatusCardData {
  const classification = classifyChildCompletionAgainstActiveTask({
    activeTaskContract: params.activeTaskContract,
    childTaskId: params.childTaskId,
    outputArtifactPaths: params.outputArtifactPaths,
  });
  const validation = normalizeActiveTaskContract(params.activeTaskContract);
  if (!validation.ok) {
    return {
      kind: "active_task_contract",
      contractVerdict: classification.contractVerdict,
      acceptanceEligible: false,
      currentTaskOutput: false,
      backgrounded: false,
      reasons: classification.reasons,
    };
  }

  const requestPriority = resolveActiveTaskCurrentRequest({
    activeTaskContract: validation.contract,
    backgroundHints: params.backgroundHints,
  });
  const taskPriorityConflicts = requestPriority.ok ? requestPriority.taskPriorityConflicts : [];
  const backgroundSignals = requestPriority.ok ? requestPriority.backgroundSignals : [];
  return {
    kind: "active_task_contract",
    activeTaskContractId: validation.activeTaskContractId,
    taskId: validation.contract.taskId,
    currentUserRequest: validation.contract.currentUserRequest,
    contractVerdict: classification.contractVerdict,
    acceptanceEligible: classification.acceptanceEligible,
    currentTaskOutput: classification.currentTaskOutput,
    backgrounded: classification.backgrounded,
    expectedOutputArtifacts: validation.contract.expectedOutputArtifacts.map(
      buildActiveTaskArtifactDebugRef,
    ),
    ...(taskPriorityConflicts.length > 0 ? { taskPriorityConflicts } : {}),
    ...(backgroundSignals.length > 0 ? { backgroundSignals } : {}),
    reasons: classification.reasons,
  };
}
