import path from "node:path";
import {
  COORDINATION_ALLOWED_JOB_TYPE,
  COORDINATION_JOB_ROOT,
  COORDINATION_REPO_ROOT,
  COORDINATION_REQUIRED_EXECUTION_MODE,
} from "./job-contract.js";

export const COORDINATION_WORK_AUTHORIZATION_SCHEMA_VERSION = "v1" as const;
export const COORDINATION_WORK_AUTHORIZATION_ROOT =
  "/Users/corey-domidocs/clawd/runtime/agent-coordination/work-authorizations" as const;
export const COORDINATION_ALLOWED_WORK_AUTHORIZATION_APPROVER = "corey" as const;
export const COORDINATION_ALLOWED_WORK_AUTHORIZATION_APPROVAL_MODE =
  "explicit_corey_bounded_objective_approval" as const;
export const COORDINATION_ALLOWED_WORK_AUTHORIZATION_WORK_ROOTS = [
  "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination",
  "/Users/corey-domidocs/clawd/runtime/agent-coordination",
] as const;
export const COORDINATION_ALLOWED_WORK_AUTHORIZATION_AGENTS = ["dom", "klaus"] as const;
export const COORDINATION_ALLOWED_WORK_AUTHORIZATION_COMMAND_CATEGORIES = [
  "narrow_coordination_test",
  "validated_coordination_command_contract",
  "safe_probe_wrapped_coordination_job",
] as const;

export type CoordinationAllowedCommandPolicy =
  | {
      category: "narrow_coordination_test";
      command: string;
    }
  | {
      category: "validated_coordination_command_contract";
      policy: "existing_command_contract_only";
    }
  | {
      category: "safe_probe_wrapped_coordination_job";
      policy: "existing_validated_job_and_command_contract_only";
    };

export type CoordinationWorkAuthorizationContract = {
  schema_version: typeof COORDINATION_WORK_AUTHORIZATION_SCHEMA_VERSION;
  authorization_id: string;
  objective_name: string;
  approved_by: typeof COORDINATION_ALLOWED_WORK_AUTHORIZATION_APPROVER;
  approval_mode: typeof COORDINATION_ALLOWED_WORK_AUTHORIZATION_APPROVAL_MODE;
  approval_statement: string;
  created_at: string;
  allowed_repo_root: typeof COORDINATION_REPO_ROOT;
  allowed_work_roots: string[];
  allowed_files: string[];
  allowed_file_patterns: string[];
  allowed_commands: CoordinationAllowedCommandPolicy[];
  allowed_test_commands: string[];
  allowed_artifact_paths: string[];
  allowed_agents: Array<(typeof COORDINATION_ALLOWED_WORK_AUTHORIZATION_AGENTS)[number]>;
  allowed_job_types: Array<typeof COORDINATION_ALLOWED_JOB_TYPE>;
  allowed_execution_modes: Array<typeof COORDINATION_REQUIRED_EXECUTION_MODE>;
  max_runtime_steps: number;
  max_retries_per_step: 0;
  forbidden_surfaces: string[];
  stop_conditions: string[];
  proof_requirements: Record<string, unknown>;
  completion_definition: Record<string, unknown>;
};

export type CoordinationWorkAuthorizationValidationErrorCode =
  | "contract_not_object"
  | "missing_required_field"
  | "invalid_string"
  | "invalid_number"
  | "invalid_string_array"
  | "invalid_object"
  | "authorization_id_invalid"
  | "approved_by_invalid"
  | "approval_mode_invalid"
  | "path_not_absolute"
  | "path_outside_approved_root"
  | "artifact_path_outside_runtime_root"
  | "raw_agent_exec_forbidden"
  | "dist_entrypoint_forbidden"
  | "shell_operator_forbidden"
  | "forbidden_surface_reference"
  | "test_command_too_broad"
  | "max_retries_invalid"
  | "forbidden_surfaces_missing"
  | "stop_conditions_missing"
  | "completion_definition_missing"
  | "unknown_execution_expanding_field"
  | "command_category_invalid"
  | "command_policy_invalid"
  | "job_type_invalid"
  | "execution_mode_invalid"
  | "agent_not_allowed"
  | "repo_root_invalid";

export class CoordinationWorkAuthorizationValidationError extends Error {
  readonly code: CoordinationWorkAuthorizationValidationErrorCode;
  readonly fieldPath: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: CoordinationWorkAuthorizationValidationErrorCode;
    fieldPath: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "CoordinationWorkAuthorizationValidationError";
    this.code = params.code;
    this.fieldPath = params.fieldPath;
    this.details = params.details;
  }
}

export function validateCoordinationWorkAuthorizationContract(
  input: unknown,
): CoordinationWorkAuthorizationContract {
  const contract = expectPlainObject(input, "$");
  rejectUnknownExecutionExpandingFields(contract, "$", [
    "schema_version",
    "authorization_id",
    "objective_name",
    "approved_by",
    "approval_mode",
    "approval_statement",
    "created_at",
    "allowed_repo_root",
    "allowed_work_roots",
    "allowed_files",
    "allowed_file_patterns",
    "allowed_commands",
    "allowed_test_commands",
    "allowed_artifact_paths",
    "allowed_agents",
    "allowed_job_types",
    "allowed_execution_modes",
    "max_runtime_steps",
    "max_retries_per_step",
    "forbidden_surfaces",
    "stop_conditions",
    "proof_requirements",
    "completion_definition",
  ]);

  const schemaVersion = expectExactString(
    contract.schema_version,
    "$.schema_version",
    COORDINATION_WORK_AUTHORIZATION_SCHEMA_VERSION,
    "invalid_string",
  );
  const authorizationId = expectAuthorizationId(contract.authorization_id, "$.authorization_id");
  const objectiveName = expectNonEmptyString(contract.objective_name, "$.objective_name");
  const approvedBy = expectExactString(
    contract.approved_by,
    "$.approved_by",
    COORDINATION_ALLOWED_WORK_AUTHORIZATION_APPROVER,
    "approved_by_invalid",
  );
  const approvalMode = expectExactString(
    contract.approval_mode,
    "$.approval_mode",
    COORDINATION_ALLOWED_WORK_AUTHORIZATION_APPROVAL_MODE,
    "approval_mode_invalid",
  );
  const approvalStatement = expectNonEmptyString(
    contract.approval_statement,
    "$.approval_statement",
  );
  const createdAt = expectNonEmptyString(contract.created_at, "$.created_at");
  const allowedRepoRoot = expectExactAbsolutePath(
    contract.allowed_repo_root,
    "$.allowed_repo_root",
    COORDINATION_REPO_ROOT,
    "repo_root_invalid",
  );
  const allowedWorkRoots = expectPathArrayWithinAllowedRoots(
    contract.allowed_work_roots,
    "$.allowed_work_roots",
  );
  const allowedFiles = expectPathArrayWithinAllowedRoots(contract.allowed_files, "$.allowed_files");
  const allowedFilePatterns = expectPathArrayWithinAllowedRoots(
    contract.allowed_file_patterns,
    "$.allowed_file_patterns",
  );
  const allowedCommands = expectAllowedCommands(contract.allowed_commands, "$.allowed_commands");
  const allowedTestCommands = expectAllowedTestCommands(
    contract.allowed_test_commands,
    "$.allowed_test_commands",
  );
  const allowedArtifactPaths = expectArtifactPaths(
    contract.allowed_artifact_paths,
    "$.allowed_artifact_paths",
  );
  const allowedAgents = expectAllowedAgents(contract.allowed_agents, "$.allowed_agents");
  const allowedJobTypes = expectExactStringArray(
    contract.allowed_job_types,
    "$.allowed_job_types",
    COORDINATION_ALLOWED_JOB_TYPE,
    "job_type_invalid",
  );
  const allowedExecutionModes = expectExactStringArray(
    contract.allowed_execution_modes,
    "$.allowed_execution_modes",
    COORDINATION_REQUIRED_EXECUTION_MODE,
    "execution_mode_invalid",
  );
  const maxRuntimeSteps = expectPositiveNumber(contract.max_runtime_steps, "$.max_runtime_steps");
  const maxRetriesPerStep = expectExactNumber(
    contract.max_retries_per_step,
    "$.max_retries_per_step",
    0,
    "max_retries_invalid",
  );
  const forbiddenSurfaces = expectRequiredStringArray(
    contract.forbidden_surfaces,
    "$.forbidden_surfaces",
    "forbidden_surfaces_missing",
  );
  const stopConditions = expectRequiredStringArray(
    contract.stop_conditions,
    "$.stop_conditions",
    "stop_conditions_missing",
  );
  const proofRequirements = expectRequiredRecord(
    contract.proof_requirements,
    "$.proof_requirements",
    "missing_required_field",
  );
  const completionDefinition = expectRequiredRecord(
    contract.completion_definition,
    "$.completion_definition",
    "completion_definition_missing",
  );

  return {
    schema_version: schemaVersion,
    authorization_id: authorizationId,
    objective_name: objectiveName,
    approved_by: approvedBy,
    approval_mode: approvalMode,
    approval_statement: approvalStatement,
    created_at: createdAt,
    allowed_repo_root: allowedRepoRoot,
    allowed_work_roots: allowedWorkRoots,
    allowed_files: allowedFiles,
    allowed_file_patterns: allowedFilePatterns,
    allowed_commands: allowedCommands,
    allowed_test_commands: allowedTestCommands,
    allowed_artifact_paths: allowedArtifactPaths,
    allowed_agents: allowedAgents,
    allowed_job_types: allowedJobTypes,
    allowed_execution_modes: allowedExecutionModes,
    max_runtime_steps: maxRuntimeSteps,
    max_retries_per_step: maxRetriesPerStep,
    forbidden_surfaces: forbiddenSurfaces,
    stop_conditions: stopConditions,
    proof_requirements: proofRequirements,
    completion_definition: completionDefinition,
  };
}

function expectAuthorizationId(value: unknown, fieldPath: string): string {
  const id = expectNonEmptyString(value, fieldPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: "authorization_id_invalid",
      fieldPath,
      message: `${fieldPath} must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/`,
    });
  }
  return id;
}

function expectAllowedCommands(
  value: unknown,
  fieldPath: string,
): CoordinationAllowedCommandPolicy[] {
  if (!Array.isArray(value)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_object",
      fieldPath,
      message: `${fieldPath} must be an array of structured command policies`,
    });
  }

  return value.map((entry, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    const record = expectPlainObject(entry, itemPath);
    const category = expectOneOfString(
      record.category,
      `${itemPath}.category`,
      COORDINATION_ALLOWED_WORK_AUTHORIZATION_COMMAND_CATEGORIES,
      "command_category_invalid",
    );

    if (category === "narrow_coordination_test") {
      const command = expectNonEmptyString(record.command, `${itemPath}.command`);
      assertNoForbiddenCommandContent(command, `${itemPath}.command`);
      assertNarrowCoordinationTestCommand(command, `${itemPath}.command`);
      return { category, command };
    }

    const policy = expectNonEmptyString(record.policy, `${itemPath}.policy`);
    if (
      (category === "validated_coordination_command_contract" &&
        policy !== "existing_command_contract_only") ||
      (category === "safe_probe_wrapped_coordination_job" &&
        policy !== "existing_validated_job_and_command_contract_only")
    ) {
      throw new CoordinationWorkAuthorizationValidationError({
        code: "command_policy_invalid",
        fieldPath: `${itemPath}.policy`,
        message: `${itemPath}.policy is not valid for category ${category}`,
      });
    }

    return { category, policy } as CoordinationAllowedCommandPolicy;
  });
}

function expectAllowedTestCommands(value: unknown, fieldPath: string): string[] {
  const commands = expectStringArray(value, fieldPath);
  for (const [index, command] of commands.entries()) {
    assertNoForbiddenCommandContent(command, `${fieldPath}[${index}]`);
    assertNarrowCoordinationTestCommand(command, `${fieldPath}[${index}]`);
  }
  return commands;
}

function assertNarrowCoordinationTestCommand(command: string, fieldPath: string): void {
  if (!/^pnpm test -- src\/agents\/coordination\/.+\.contract\.test\.ts$/u.test(command)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: "test_command_too_broad",
      fieldPath,
      message: `${fieldPath} must be a narrow coordination contract test command`,
      details: { actual: command },
    });
  }
}

function assertNoForbiddenCommandContent(command: string, fieldPath: string): void {
  if (/[|;&]/u.test(command)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: "shell_operator_forbidden",
      fieldPath,
      message: `${fieldPath} must not contain shell operators`,
      details: { actual: command },
    });
  }
  if (/\bagent-exec\b/u.test(command)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: "raw_agent_exec_forbidden",
      fieldPath,
      message: `${fieldPath} must not include raw agent-exec`,
      details: { actual: command },
    });
  }
  if (/dist\/openclaw\.mjs/u.test(command)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: "dist_entrypoint_forbidden",
      fieldPath,
      message: `${fieldPath} must not include dist/openclaw.mjs`,
      details: { actual: command },
    });
  }
  if (/slack|mcp|zapier|publish|schedule/iu.test(command)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: "forbidden_surface_reference",
      fieldPath,
      message: `${fieldPath} must not reference forbidden surfaces`,
      details: { actual: command },
    });
  }
}

function expectArtifactPaths(value: unknown, fieldPath: string): string[] {
  const paths = expectStringArray(value, fieldPath);
  const approvedRoot = path.resolve(path.dirname(COORDINATION_JOB_ROOT));
  const workAuthorizationRoot = path.resolve(COORDINATION_WORK_AUTHORIZATION_ROOT);
  for (const [index, candidate] of paths.entries()) {
    const normalized = normalizeAbsolutePath(
      candidate,
      `${fieldPath}[${index}]`,
      "path_not_absolute",
    );
    const runtimeRootWithSep = `${approvedRoot}${path.sep}`;
    const workAuthRootWithSep = `${workAuthorizationRoot}${path.sep}`;
    if (
      normalized !== approvedRoot &&
      normalized !== workAuthorizationRoot &&
      !normalized.startsWith(runtimeRootWithSep) &&
      !normalized.startsWith(workAuthRootWithSep)
    ) {
      throw new CoordinationWorkAuthorizationValidationError({
        code: "artifact_path_outside_runtime_root",
        fieldPath: `${fieldPath}[${index}]`,
        message: `${fieldPath}[${index}] must stay within the approved runtime coordination root`,
      });
    }
  }
  return paths;
}

function expectAllowedAgents(
  value: unknown,
  fieldPath: string,
): Array<(typeof COORDINATION_ALLOWED_WORK_AUTHORIZATION_AGENTS)[number]> {
  const agents = expectStringArray(value, fieldPath);
  return agents.map((agent, index) =>
    expectOneOfString(
      agent,
      `${fieldPath}[${index}]`,
      COORDINATION_ALLOWED_WORK_AUTHORIZATION_AGENTS,
      "agent_not_allowed",
    ),
  );
}

function expectPathArrayWithinAllowedRoots(value: unknown, fieldPath: string): string[] {
  const paths = expectStringArray(value, fieldPath);
  for (const [index, candidate] of paths.entries()) {
    assertPathWithinAllowedRoots(candidate, `${fieldPath}[${index}]`);
  }
  return paths;
}

function assertPathWithinAllowedRoots(candidate: string, fieldPath: string): void {
  const normalized = normalizeAbsolutePath(candidate, fieldPath, "path_not_absolute");
  const approvedRoots = COORDINATION_ALLOWED_WORK_AUTHORIZATION_WORK_ROOTS.map((root) =>
    path.resolve(root),
  );
  if (
    !approvedRoots.some(
      (root) => normalized === root || normalized.startsWith(`${root}${path.sep}`),
    )
  ) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: "path_outside_approved_root",
      fieldPath,
      message: `${fieldPath} must stay within the approved work roots`,
      details: { actual: normalized },
    });
  }
}

function expectPlainObject(value: unknown, fieldPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: value === undefined ? "missing_required_field" : "contract_not_object",
      fieldPath,
      message: `${fieldPath} must be an object`,
    });
  }
  return value as Record<string, unknown>;
}

function expectRequiredRecord(
  value: unknown,
  fieldPath: string,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must be a non-array object`,
    });
  }
  return value as Record<string, unknown>;
}

function expectNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_string",
      fieldPath,
      message: `${fieldPath} must be a non-empty string`,
    });
  }
  return value;
}

function expectStringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_string_array",
      fieldPath,
      message: `${fieldPath} must be an array of strings`,
    });
  }
  return value.map((entry, index) => expectNonEmptyString(entry, `${fieldPath}[${index}]`));
}

function expectRequiredStringArray(
  value: unknown,
  fieldPath: string,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): string[] {
  const entries = expectStringArray(value, fieldPath);
  if (entries.length === 0) {
    throw new CoordinationWorkAuthorizationValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must not be empty`,
    });
  }
  return entries;
}

function expectExactString<T extends string>(
  value: unknown,
  fieldPath: string,
  expected: T,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): T {
  const actual = expectNonEmptyString(value, fieldPath);
  if (actual !== expected) {
    throw new CoordinationWorkAuthorizationValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must exactly equal ${JSON.stringify(expected)}`,
      details: { expected, actual },
    });
  }
  return expected;
}

function expectOneOfString<T extends readonly string[]>(
  value: unknown,
  fieldPath: string,
  allowed: T,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): T[number] {
  const actual = expectNonEmptyString(value, fieldPath);
  if (!allowed.includes(actual as T[number])) {
    throw new CoordinationWorkAuthorizationValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must be one of ${allowed.join(", ")}`,
      details: { actual },
    });
  }
  return actual as T[number];
}

function expectExactStringArray<T extends string>(
  value: unknown,
  fieldPath: string,
  expected: T,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): T[] {
  return expectStringArray(value, fieldPath).map((entry, index) => {
    if (entry !== expected) {
      throw new CoordinationWorkAuthorizationValidationError({
        code,
        fieldPath: `${fieldPath}[${index}]`,
        message: `${fieldPath}[${index}] must exactly equal ${JSON.stringify(expected)}`,
        details: { expected, actual: entry },
      });
    }
    return expected;
  });
}

function expectPositiveNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new CoordinationWorkAuthorizationValidationError({
      code: value === undefined ? "missing_required_field" : "invalid_number",
      fieldPath,
      message: `${fieldPath} must be a positive number`,
    });
  }
  return value;
}

function expectExactNumber(
  value: unknown,
  fieldPath: string,
  expected: number,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): 0 {
  if (typeof value !== "number" || value !== expected) {
    throw new CoordinationWorkAuthorizationValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must exactly equal ${expected}`,
      details: { expected, actual: value },
    });
  }
  return 0;
}

function expectExactAbsolutePath<T extends string>(
  value: unknown,
  fieldPath: string,
  expected: T,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): T {
  const normalized = normalizeAbsolutePath(value, fieldPath, "path_not_absolute");
  if (normalized !== expected) {
    throw new CoordinationWorkAuthorizationValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must exactly equal the approved constant`,
      details: { expected, actual: normalized },
    });
  }
  return expected;
}

function normalizeAbsolutePath(
  value: unknown,
  fieldPath: string,
  code: CoordinationWorkAuthorizationValidationErrorCode,
): string {
  const raw = expectNonEmptyString(value, fieldPath);
  const normalized = path.normalize(raw);
  if (!path.isAbsolute(normalized)) {
    throw new CoordinationWorkAuthorizationValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must be an absolute path`,
      details: { actual: raw },
    });
  }
  return normalized;
}

function rejectUnknownExecutionExpandingFields(
  record: Record<string, unknown>,
  fieldPath: string,
  allowedKeys: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new CoordinationWorkAuthorizationValidationError({
        code: "unknown_execution_expanding_field",
        fieldPath: `${fieldPath}.${key}`,
        message: `Unknown execution-expanding field is not allowed: ${key}`,
      });
    }
  }
}
