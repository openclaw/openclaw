import path from "node:path";

export const COORDINATION_JOB_SCHEMA_VERSION = "v1" as const;
export const COORDINATION_REPO_ROOT = "/Users/corey-domidocs/src/openclaw-2026.4.21" as const;
export const COORDINATION_JOB_ROOT =
  "/Users/corey-domidocs/clawd/runtime/agent-coordination/jobs" as const;
export const COORDINATION_SAFE_PROBE_PATH =
  "/Users/corey-domidocs/src/openclaw-2026.4.21/scripts/agent-exec-safe-probe.mjs" as const;
export const COORDINATION_ENTRYPOINT_PATH =
  "/Users/corey-domidocs/src/openclaw-2026.4.21/openclaw.mjs" as const;
export const COORDINATION_ALLOWED_AGENT = "klaus" as const;
export const COORDINATION_ALLOWED_JOB_TYPE = "coordination_agent_probe" as const;
export const COORDINATION_ALLOWED_TOOL_POLICY = "coordination_only" as const;
export const COORDINATION_ALLOWED_APPROVAL_MODE = "explicit_corey_job_approval" as const;
export const COORDINATION_REQUIRED_APPROVER = "corey" as const;
export const COORDINATION_REQUIRED_APPROVAL_STATEMENT =
  "Corey explicitly approved this exact coordination-only watchdog job." as const;
export const COORDINATION_REQUIRED_EXECUTION_MODE = "safe_probe_wrapped_agent_exec" as const;
export const COORDINATION_MAX_RETRIES = 0 as const;

export type CoordinationJobContract = {
  schema_version: typeof COORDINATION_JOB_SCHEMA_VERSION;
  id: string;
  created_at: string;
  approval_mode: typeof COORDINATION_ALLOWED_APPROVAL_MODE;
  approved_by: typeof COORDINATION_REQUIRED_APPROVER;
  approval_statement: typeof COORDINATION_REQUIRED_APPROVAL_STATEMENT;
  approval_scope: {
    job_id: string;
    agent_id: typeof COORDINATION_ALLOWED_AGENT;
    job_type: typeof COORDINATION_ALLOWED_JOB_TYPE;
    tool_policy: typeof COORDINATION_ALLOWED_TOOL_POLICY;
    timeout_seconds: number;
    entrypoint: typeof COORDINATION_ENTRYPOINT_PATH;
    job_path: string;
  };
  agent: typeof COORDINATION_ALLOWED_AGENT;
  tool_policy: typeof COORDINATION_ALLOWED_TOOL_POLICY;
  context: {
    tool_policy: typeof COORDINATION_ALLOWED_TOOL_POLICY;
  };
  execution_mode: typeof COORDINATION_REQUIRED_EXECUTION_MODE;
  job_type: typeof COORDINATION_ALLOWED_JOB_TYPE;
  intent_summary: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  approved_paths: {
    repo_root: typeof COORDINATION_REPO_ROOT;
    job_root: typeof COORDINATION_JOB_ROOT;
    entrypoint: typeof COORDINATION_ENTRYPOINT_PATH;
    safe_probe: typeof COORDINATION_SAFE_PROBE_PATH;
    node_binary: string;
  };
  timeout_seconds: number;
  max_retries: typeof COORDINATION_MAX_RETRIES;
  expected_markers: string[];
  forbidden_markers: string[];
  cleanup_requirements: {
    require_no_stale_lock: boolean;
    require_no_orphan_openclaw_children: boolean;
    require_no_mcp_remote: boolean;
    require_no_zapier_process: boolean;
    require_no_proof_tied_slack_runtime: boolean;
  };
};

export type CoordinationJobContractValidationErrorCode =
  | "contract_not_object"
  | "missing_required_field"
  | "invalid_string"
  | "invalid_number"
  | "invalid_boolean"
  | "invalid_string_array"
  | "unknown_execution_expanding_field"
  | "schema_version_invalid"
  | "agent_not_allowed"
  | "job_type_not_allowed"
  | "tool_policy_not_allowed"
  | "execution_mode_not_allowed"
  | "approval_mode_not_allowed"
  | "approved_by_invalid"
  | "approval_statement_invalid"
  | "context_missing"
  | "context_tool_policy_mismatch"
  | "timeout_invalid"
  | "max_retries_invalid"
  | "path_not_absolute"
  | "path_outside_approved_root"
  | "approved_path_mismatch"
  | "entrypoint_invalid"
  | "dist_entrypoint_forbidden"
  | "approval_scope_mismatch";

export class CoordinationJobContractValidationError extends Error {
  readonly code: CoordinationJobContractValidationErrorCode;
  readonly fieldPath: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: CoordinationJobContractValidationErrorCode;
    fieldPath: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "CoordinationJobContractValidationError";
    this.code = params.code;
    this.fieldPath = params.fieldPath;
    this.details = params.details;
  }
}

export function validateCoordinationJobContract(
  input: unknown,
  options: { jobPath: string },
): CoordinationJobContract {
  const contract = expectPlainObject(input, "$");
  rejectUnknownExecutionExpandingFields(contract, "$", [
    "schema_version",
    "id",
    "created_at",
    "approval_mode",
    "approved_by",
    "approval_statement",
    "approval_scope",
    "agent",
    "tool_policy",
    "context",
    "execution_mode",
    "job_type",
    "intent_summary",
    "allowed_actions",
    "forbidden_actions",
    "approved_paths",
    "timeout_seconds",
    "max_retries",
    "expected_markers",
    "forbidden_markers",
    "cleanup_requirements",
  ]);

  const normalizedJobPath = assertApprovedJobPath(options.jobPath, "options.jobPath");

  const schemaVersion = expectExactString(
    contract.schema_version,
    "$.schema_version",
    COORDINATION_JOB_SCHEMA_VERSION,
    "schema_version_invalid",
  );
  const id = expectNonEmptyString(contract.id, "$.id");
  const createdAt = expectNonEmptyString(contract.created_at, "$.created_at");
  const approvalMode = expectExactString(
    contract.approval_mode,
    "$.approval_mode",
    COORDINATION_ALLOWED_APPROVAL_MODE,
    "approval_mode_not_allowed",
  );
  const approvedBy = expectExactString(
    contract.approved_by,
    "$.approved_by",
    COORDINATION_REQUIRED_APPROVER,
    "approved_by_invalid",
  );
  const approvalStatement = expectExactString(
    contract.approval_statement,
    "$.approval_statement",
    COORDINATION_REQUIRED_APPROVAL_STATEMENT,
    "approval_statement_invalid",
  );
  const approvalScope = expectPlainObject(contract.approval_scope, "$.approval_scope");
  rejectUnknownExecutionExpandingFields(approvalScope, "$.approval_scope", [
    "job_id",
    "agent_id",
    "job_type",
    "tool_policy",
    "timeout_seconds",
    "entrypoint",
    "job_path",
  ]);
  const agent = expectExactString(
    contract.agent,
    "$.agent",
    COORDINATION_ALLOWED_AGENT,
    "agent_not_allowed",
  );
  const toolPolicy = expectExactString(
    contract.tool_policy,
    "$.tool_policy",
    COORDINATION_ALLOWED_TOOL_POLICY,
    "tool_policy_not_allowed",
  );
  const context = expectPlainObject(contract.context, "$.context", "context_missing");
  rejectUnknownExecutionExpandingFields(context, "$.context", ["tool_policy"]);
  const contextToolPolicy = expectExactString(
    context.tool_policy,
    "$.context.tool_policy",
    COORDINATION_ALLOWED_TOOL_POLICY,
    "context_tool_policy_mismatch",
  );
  if (contextToolPolicy !== toolPolicy) {
    throw new CoordinationJobContractValidationError({
      code: "context_tool_policy_mismatch",
      fieldPath: "$.context.tool_policy",
      message: "context.tool_policy must exactly match top-level tool_policy",
      details: { expected: toolPolicy, actual: contextToolPolicy },
    });
  }
  const executionMode = expectExactString(
    contract.execution_mode,
    "$.execution_mode",
    COORDINATION_REQUIRED_EXECUTION_MODE,
    "execution_mode_not_allowed",
  );
  const jobType = expectExactString(
    contract.job_type,
    "$.job_type",
    COORDINATION_ALLOWED_JOB_TYPE,
    "job_type_not_allowed",
  );
  const intentSummary = expectNonEmptyString(contract.intent_summary, "$.intent_summary");
  const allowedActions = expectStringArray(contract.allowed_actions, "$.allowed_actions");
  const forbiddenActions = expectStringArray(contract.forbidden_actions, "$.forbidden_actions");
  const approvedPaths = expectPlainObject(contract.approved_paths, "$.approved_paths");
  rejectUnknownExecutionExpandingFields(approvedPaths, "$.approved_paths", [
    "repo_root",
    "job_root",
    "entrypoint",
    "safe_probe",
    "node_binary",
  ]);
  const timeoutSeconds = expectPositiveNumber(contract.timeout_seconds, "$.timeout_seconds");
  const maxRetries = expectExactNumber(
    contract.max_retries,
    "$.max_retries",
    COORDINATION_MAX_RETRIES,
    "max_retries_invalid",
  );
  const expectedMarkers = expectStringArray(contract.expected_markers, "$.expected_markers");
  const forbiddenMarkers = expectStringArray(contract.forbidden_markers, "$.forbidden_markers");
  const cleanupRequirements = expectPlainObject(
    contract.cleanup_requirements,
    "$.cleanup_requirements",
  );
  rejectUnknownExecutionExpandingFields(cleanupRequirements, "$.cleanup_requirements", [
    "require_no_stale_lock",
    "require_no_orphan_openclaw_children",
    "require_no_mcp_remote",
    "require_no_zapier_process",
    "require_no_proof_tied_slack_runtime",
  ]);

  const repoRoot = expectExactAbsolutePath(
    approvedPaths.repo_root,
    "$.approved_paths.repo_root",
    COORDINATION_REPO_ROOT,
  );
  const jobRoot = expectExactAbsolutePath(
    approvedPaths.job_root,
    "$.approved_paths.job_root",
    COORDINATION_JOB_ROOT,
  );
  const entrypoint = expectApprovedEntrypoint(
    approvedPaths.entrypoint,
    "$.approved_paths.entrypoint",
  );
  const safeProbe = expectExactAbsolutePath(
    approvedPaths.safe_probe,
    "$.approved_paths.safe_probe",
    COORDINATION_SAFE_PROBE_PATH,
  );
  const nodeBinary = expectAbsolutePath(approvedPaths.node_binary, "$.approved_paths.node_binary");

  const cleanup = {
    require_no_stale_lock: expectBoolean(
      cleanupRequirements.require_no_stale_lock,
      "$.cleanup_requirements.require_no_stale_lock",
    ),
    require_no_orphan_openclaw_children: expectBoolean(
      cleanupRequirements.require_no_orphan_openclaw_children,
      "$.cleanup_requirements.require_no_orphan_openclaw_children",
    ),
    require_no_mcp_remote: expectBoolean(
      cleanupRequirements.require_no_mcp_remote,
      "$.cleanup_requirements.require_no_mcp_remote",
    ),
    require_no_zapier_process: expectBoolean(
      cleanupRequirements.require_no_zapier_process,
      "$.cleanup_requirements.require_no_zapier_process",
    ),
    require_no_proof_tied_slack_runtime: expectBoolean(
      cleanupRequirements.require_no_proof_tied_slack_runtime,
      "$.cleanup_requirements.require_no_proof_tied_slack_runtime",
    ),
  };

  const resolvedApprovalScope = {
    job_id: expectNonEmptyString(approvalScope.job_id, "$.approval_scope.job_id"),
    agent_id: expectExactString(
      approvalScope.agent_id,
      "$.approval_scope.agent_id",
      COORDINATION_ALLOWED_AGENT,
      "approval_scope_mismatch",
    ),
    job_type: expectExactString(
      approvalScope.job_type,
      "$.approval_scope.job_type",
      COORDINATION_ALLOWED_JOB_TYPE,
      "approval_scope_mismatch",
    ),
    tool_policy: expectExactString(
      approvalScope.tool_policy,
      "$.approval_scope.tool_policy",
      COORDINATION_ALLOWED_TOOL_POLICY,
      "approval_scope_mismatch",
    ),
    timeout_seconds: expectPositiveNumber(
      approvalScope.timeout_seconds,
      "$.approval_scope.timeout_seconds",
    ),
    entrypoint: expectApprovedEntrypoint(approvalScope.entrypoint, "$.approval_scope.entrypoint"),
    job_path: assertApprovedJobPath(approvalScope.job_path, "$.approval_scope.job_path"),
  };

  assertApprovalScopeMatch({
    actual: {
      job_id: id,
      agent_id: agent,
      job_type: jobType,
      tool_policy: toolPolicy,
      timeout_seconds: timeoutSeconds,
      entrypoint,
      job_path: normalizedJobPath,
    },
    approvalScope: resolvedApprovalScope,
  });

  if (resolvedApprovalScope.job_path !== normalizedJobPath) {
    throw new CoordinationJobContractValidationError({
      code: "approval_scope_mismatch",
      fieldPath: "$.approval_scope.job_path",
      message: "approval_scope.job_path must exactly match the live job path",
      details: {
        expected: normalizedJobPath,
        actual: resolvedApprovalScope.job_path,
      },
    });
  }

  return {
    schema_version: schemaVersion,
    id,
    created_at: createdAt,
    approval_mode: approvalMode,
    approved_by: approvedBy,
    approval_statement: approvalStatement,
    approval_scope: resolvedApprovalScope,
    agent,
    tool_policy: toolPolicy,
    context: {
      tool_policy: contextToolPolicy,
    },
    execution_mode: executionMode,
    job_type: jobType,
    intent_summary: intentSummary,
    allowed_actions: allowedActions,
    forbidden_actions: forbiddenActions,
    approved_paths: {
      repo_root: repoRoot,
      job_root: jobRoot,
      entrypoint,
      safe_probe: safeProbe,
      node_binary: nodeBinary,
    },
    timeout_seconds: timeoutSeconds,
    max_retries: maxRetries,
    expected_markers: expectedMarkers,
    forbidden_markers: forbiddenMarkers,
    cleanup_requirements: cleanup,
  };
}

function expectPlainObject(
  value: unknown,
  fieldPath: string,
  missingCode: CoordinationJobContractValidationErrorCode = "missing_required_field",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoordinationJobContractValidationError({
      code:
        fieldPath === "$"
          ? "contract_not_object"
          : value === undefined
            ? missingCode
            : "missing_required_field",
      fieldPath,
      message: `${fieldPath} must be a plain object`,
    });
  }
  return value as Record<string, unknown>;
}

function rejectUnknownExecutionExpandingFields(
  value: Record<string, unknown>,
  fieldPath: string,
  allowedKeys: string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CoordinationJobContractValidationError({
        code: "unknown_execution_expanding_field",
        fieldPath: `${fieldPath}.${key}`,
        message: `Unknown field is not allowed at ${fieldPath}.${key}`,
      });
    }
  }
}

function expectNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string") {
    throw new CoordinationJobContractValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_string",
      fieldPath,
      message: `${fieldPath} must be a non-empty string`,
    });
  }
  if (value.length === 0) {
    throw new CoordinationJobContractValidationError({
      code: "invalid_string",
      fieldPath,
      message: `${fieldPath} must be a non-empty string`,
    });
  }
  return value;
}

function expectExactString<T extends string>(
  value: unknown,
  fieldPath: string,
  expected: T,
  code:
    | "schema_version_invalid"
    | "agent_not_allowed"
    | "job_type_not_allowed"
    | "tool_policy_not_allowed"
    | "execution_mode_not_allowed"
    | "approval_mode_not_allowed"
    | "approved_by_invalid"
    | "approval_statement_invalid"
    | "approval_scope_mismatch"
    | "context_tool_policy_mismatch",
): T {
  const actual = expectNonEmptyString(value, fieldPath);
  if (actual !== expected) {
    throw new CoordinationJobContractValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must exactly equal ${JSON.stringify(expected)}`,
      details: { expected, actual },
    });
  }
  return expected;
}

function expectPositiveNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new CoordinationJobContractValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_number",
      fieldPath,
      message: `${fieldPath} must be a positive number`,
    });
  }
  if (value <= 0) {
    throw new CoordinationJobContractValidationError({
      code: "timeout_invalid",
      fieldPath,
      message: `${fieldPath} must be a positive number`,
      details: { actual: value },
    });
  }
  return value;
}

function expectExactNumber<T extends number>(
  value: unknown,
  fieldPath: string,
  expected: T,
  code: "max_retries_invalid",
): T {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new CoordinationJobContractValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_number",
      fieldPath,
      message: `${fieldPath} must exactly equal ${expected}`,
    });
  }
  if (value !== expected) {
    throw new CoordinationJobContractValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must exactly equal ${expected}`,
      details: { expected, actual: value },
    });
  }
  return expected;
}

function expectStringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new CoordinationJobContractValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_string_array",
      fieldPath,
      message: `${fieldPath} must be a string array`,
    });
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new CoordinationJobContractValidationError({
        code: "invalid_string_array",
        fieldPath: `${fieldPath}[${index}]`,
        message: `${fieldPath}[${index}] must be a non-empty string`,
      });
    }
    result.push(entry);
  }
  return result;
}

function expectBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new CoordinationJobContractValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_boolean",
      fieldPath,
      message: `${fieldPath} must be a boolean`,
    });
  }
  return value;
}

function expectAbsolutePath(value: unknown, fieldPath: string): string {
  const raw = expectNonEmptyString(value, fieldPath);
  const normalized = path.normalize(raw);
  if (!path.isAbsolute(normalized)) {
    throw new CoordinationJobContractValidationError({
      code: "path_not_absolute",
      fieldPath,
      message: `${fieldPath} must be an absolute path`,
      details: { actual: raw },
    });
  }
  return normalized;
}

function expectExactAbsolutePath<T extends string>(
  value: unknown,
  fieldPath: string,
  expected: T,
): T {
  const normalized = expectAbsolutePath(value, fieldPath);
  if (normalized !== expected) {
    throw new CoordinationJobContractValidationError({
      code: "approved_path_mismatch",
      fieldPath,
      message: `${fieldPath} must exactly equal the approved constant`,
      details: { expected, actual: normalized },
    });
  }
  return expected;
}

function expectApprovedEntrypoint(
  value: unknown,
  fieldPath: string,
): typeof COORDINATION_ENTRYPOINT_PATH {
  const normalized = expectAbsolutePath(value, fieldPath);
  if (
    normalized.includes(`${path.sep}dist${path.sep}`) ||
    normalized.endsWith(`${path.sep}dist/openclaw.mjs`)
  ) {
    throw new CoordinationJobContractValidationError({
      code: "dist_entrypoint_forbidden",
      fieldPath,
      message: `${fieldPath} must not reference dist/openclaw.mjs`,
      details: { actual: normalized },
    });
  }
  if (normalized !== COORDINATION_ENTRYPOINT_PATH) {
    throw new CoordinationJobContractValidationError({
      code: "entrypoint_invalid",
      fieldPath,
      message: `${fieldPath} must exactly equal the approved source openclaw.mjs entrypoint`,
      details: { expected: COORDINATION_ENTRYPOINT_PATH, actual: normalized },
    });
  }
  return COORDINATION_ENTRYPOINT_PATH;
}

function assertApprovedJobPath(value: unknown, fieldPath: string): string {
  const normalized = expectAbsolutePath(value, fieldPath);
  const rootWithSep = `${COORDINATION_JOB_ROOT}${path.sep}`;
  if (normalized !== COORDINATION_JOB_ROOT && !normalized.startsWith(rootWithSep)) {
    throw new CoordinationJobContractValidationError({
      code: "path_outside_approved_root",
      fieldPath,
      message: `${fieldPath} must stay within the approved coordination job root`,
      details: { approved_root: COORDINATION_JOB_ROOT, actual: normalized },
    });
  }
  return normalized;
}

function assertApprovalScopeMatch(params: {
  actual: {
    job_id: string;
    agent_id: string;
    job_type: string;
    tool_policy: string;
    timeout_seconds: number;
    entrypoint: string;
    job_path: string;
  };
  approvalScope: {
    job_id: string;
    agent_id: string;
    job_type: string;
    tool_policy: string;
    timeout_seconds: number;
    entrypoint: string;
    job_path: string;
  };
}): void {
  for (const key of [
    "job_id",
    "agent_id",
    "job_type",
    "tool_policy",
    "timeout_seconds",
    "entrypoint",
    "job_path",
  ] as const) {
    if (params.actual[key] !== params.approvalScope[key]) {
      throw new CoordinationJobContractValidationError({
        code: "approval_scope_mismatch",
        fieldPath: `$.approval_scope.${key}`,
        message: `approval_scope.${key} must exactly match the live job contract`,
        details: {
          expected: params.actual[key],
          actual: params.approvalScope[key],
        },
      });
    }
  }
}
