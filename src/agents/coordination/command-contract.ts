import path from "node:path";
import {
  COORDINATION_ALLOWED_AGENT,
  COORDINATION_ALLOWED_TOOL_POLICY,
  COORDINATION_ENTRYPOINT_PATH,
  COORDINATION_JOB_ROOT,
  COORDINATION_REPO_ROOT,
  COORDINATION_SAFE_PROBE_PATH,
  type CoordinationJobContract,
} from "./job-contract.js";

export type CoordinationRenderedCommand = {
  env: {
    OPENCLAW_AGENT_EXEC_DEBUG: "1";
  };
  cwd: typeof COORDINATION_REPO_ROOT;
  command: string;
  args: [
    "scripts/agent-exec-safe-probe.mjs",
    "--job-id",
    string,
    "--out",
    string,
    "--timeout-ms",
    string,
    "--agent",
    typeof COORDINATION_ALLOWED_AGENT,
    "--tool-policy",
    typeof COORDINATION_ALLOWED_TOOL_POLICY,
    "--",
    string,
    typeof COORDINATION_ENTRYPOINT_PATH,
    "agent-exec",
    "--agent",
    typeof COORDINATION_ALLOWED_AGENT,
    "--job-id",
    string,
    "--job-path",
    string,
    "--timeout",
    string,
    "--tool-policy",
    typeof COORDINATION_ALLOWED_TOOL_POLICY,
    "--json",
  ];
};

export type CoordinationCommandContractValidationErrorCode =
  | "invalid_rendered_command"
  | "cwd_mismatch"
  | "command_mismatch"
  | "env_invalid"
  | "safe_probe_wrapper_required"
  | "safe_probe_path_invalid"
  | "wrapper_job_id_mismatch"
  | "wrapper_out_missing"
  | "wrapper_out_invalid"
  | "wrapper_timeout_flag_missing"
  | "wrapper_timeout_mismatch"
  | "wrapper_agent_mismatch"
  | "wrapper_tool_policy_mismatch"
  | "inner_node_binary_mismatch"
  | "inner_entrypoint_mismatch"
  | "dist_entrypoint_forbidden"
  | "inner_command_mismatch"
  | "inner_agent_mismatch"
  | "inner_job_id_mismatch"
  | "inner_job_path_mismatch"
  | "inner_timeout_mismatch"
  | "inner_tool_policy_missing"
  | "inner_tool_policy_mismatch"
  | "json_flag_missing"
  | "extra_args_forbidden"
  | "raw_agent_exec_without_wrapper"
  | "job_path_outside_approved_root"
  | "unsafe_freeform_value";

export class CoordinationCommandContractValidationError extends Error {
  readonly code: CoordinationCommandContractValidationErrorCode;
  readonly fieldPath: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: CoordinationCommandContractValidationErrorCode;
    fieldPath: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "CoordinationCommandContractValidationError";
    this.code = params.code;
    this.fieldPath = params.fieldPath;
    this.details = params.details;
  }
}

export function renderCoordinationCommand(
  validatedJob: CoordinationJobContract,
): CoordinationRenderedCommand {
  assertValidatedJobForCommandRendering(validatedJob);
  const timeout = String(validatedJob.timeout_seconds);
  const wrapperTimeoutMs = String(validatedJob.timeout_seconds * 1000);
  const wrapperOutPath = getApprovedSafeProbeResultPath(validatedJob);
  return {
    env: {
      OPENCLAW_AGENT_EXEC_DEBUG: "1",
    },
    cwd: COORDINATION_REPO_ROOT,
    command: validatedJob.approved_paths.node_binary,
    args: [
      "scripts/agent-exec-safe-probe.mjs",
      "--job-id",
      validatedJob.id,
      "--out",
      wrapperOutPath,
      "--timeout-ms",
      wrapperTimeoutMs,
      "--agent",
      COORDINATION_ALLOWED_AGENT,
      "--tool-policy",
      COORDINATION_ALLOWED_TOOL_POLICY,
      "--",
      validatedJob.approved_paths.node_binary,
      COORDINATION_ENTRYPOINT_PATH,
      "agent-exec",
      "--agent",
      COORDINATION_ALLOWED_AGENT,
      "--job-id",
      validatedJob.id,
      "--job-path",
      validatedJob.approval_scope.job_path,
      "--timeout",
      timeout,
      "--tool-policy",
      COORDINATION_ALLOWED_TOOL_POLICY,
      "--json",
    ],
  };
}

export function validateRenderedCoordinationCommand(
  renderedCommand: unknown,
  validatedJob: CoordinationJobContract,
): CoordinationRenderedCommand {
  assertValidatedJobForCommandRendering(validatedJob);
  if (
    typeof renderedCommand !== "object" ||
    renderedCommand === null ||
    Array.isArray(renderedCommand)
  ) {
    throw new CoordinationCommandContractValidationError({
      code: "invalid_rendered_command",
      fieldPath: "$",
      message: "Rendered command must be a structured object",
    });
  }
  const candidate = renderedCommand as Record<string, unknown>;
  const env = expectPlainObject(candidate.env, "$.env");
  const cwd = expectExactString(candidate.cwd, "$.cwd", COORDINATION_REPO_ROOT, "cwd_mismatch");
  const command = expectApprovedAbsoluteNodeBinary(candidate.command, validatedJob, "$.command");
  if (env.OPENCLAW_AGENT_EXEC_DEBUG !== "1") {
    throw new CoordinationCommandContractValidationError({
      code: "env_invalid",
      fieldPath: "$.env.OPENCLAW_AGENT_EXEC_DEBUG",
      message: 'OPENCLAW_AGENT_EXEC_DEBUG must equal "1"',
      details: { actual: env.OPENCLAW_AGENT_EXEC_DEBUG },
    });
  }
  if (!Array.isArray(candidate.args)) {
    throw new CoordinationCommandContractValidationError({
      code: "invalid_rendered_command",
      fieldPath: "$.args",
      message: "args must be an array",
    });
  }
  const args = candidate.args;
  const expected = renderCoordinationCommand(validatedJob);
  const expectedArgs = expected.args;

  if (args.length !== expectedArgs.length) {
    const rawAgentExec =
      args.includes("agent-exec") && !args.includes("scripts/agent-exec-safe-probe.mjs");
    throw new CoordinationCommandContractValidationError({
      code: rawAgentExec ? "raw_agent_exec_without_wrapper" : "extra_args_forbidden",
      fieldPath: "$.args",
      message: rawAgentExec
        ? "Raw agent-exec without the safe-probe wrapper is forbidden"
        : "Extra or missing args are forbidden",
      details: { expected_length: expectedArgs.length, actual_length: args.length },
    });
  }

  const stringArgs = args.map((value, index) => {
    if (typeof value !== "string") {
      throw new CoordinationCommandContractValidationError({
        code: "invalid_rendered_command",
        fieldPath: `$.args[${index}]`,
        message: "Every arg must be a string",
      });
    }
    if (/[|;&]/u.test(value)) {
      throw new CoordinationCommandContractValidationError({
        code: "unsafe_freeform_value",
        fieldPath: `$.args[${index}]`,
        message: "Shell operators are forbidden in structured command args",
        details: { actual: value },
      });
    }
    return value;
  });

  if (stringArgs[0] !== "scripts/agent-exec-safe-probe.mjs") {
    throw new CoordinationCommandContractValidationError({
      code: "safe_probe_wrapper_required",
      fieldPath: "$.args[0]",
      message: "The safe-probe wrapper is required",
      details: { actual: stringArgs[0] },
    });
  }
  const resolvedSafeProbe = path.resolve(cwd, stringArgs[0]);
  if (resolvedSafeProbe !== COORDINATION_SAFE_PROBE_PATH) {
    throw new CoordinationCommandContractValidationError({
      code: "safe_probe_path_invalid",
      fieldPath: "$.args[0]",
      message: "Safe-probe path must resolve to the approved script path",
      details: { expected: COORDINATION_SAFE_PROBE_PATH, actual: resolvedSafeProbe },
    });
  }

  if (stringArgs[2] !== validatedJob.id) {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_job_id_mismatch",
      fieldPath: "$.args[2]",
      message: "Wrapper job id must match the validated job id",
      details: { expected: validatedJob.id, actual: stringArgs[2] },
    });
  }
  if (stringArgs[3] !== "--out") {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_out_missing",
      fieldPath: "$.args[3]",
      message: "Wrapper --out is required",
      details: { actual: stringArgs[3] },
    });
  }
  const normalizedWrapperOut = assertApprovedSafeProbeResultPath(
    stringArgs[4],
    validatedJob,
    "$.args[4]",
  );
  if (normalizedWrapperOut !== getApprovedSafeProbeResultPath(validatedJob)) {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_out_invalid",
      fieldPath: "$.args[4]",
      message: "Wrapper --out must equal the approved job-dir safe-probe-result.json path",
      details: {
        expected: getApprovedSafeProbeResultPath(validatedJob),
        actual: normalizedWrapperOut,
      },
    });
  }
  if (stringArgs[5] !== "--timeout-ms") {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_timeout_flag_missing",
      fieldPath: "$.args[5]",
      message: "Wrapper --timeout-ms is required",
      details: { actual: stringArgs[5] },
    });
  }
  if (stringArgs[6] !== String(validatedJob.timeout_seconds * 1000)) {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_timeout_mismatch",
      fieldPath: "$.args[6]",
      message: "Wrapper timeout must match the validated timeout in milliseconds",
      details: { expected: String(validatedJob.timeout_seconds * 1000), actual: stringArgs[6] },
    });
  }
  if (stringArgs[8] !== COORDINATION_ALLOWED_AGENT) {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_agent_mismatch",
      fieldPath: "$.args[8]",
      message: "Wrapper agent must be klaus",
      details: { actual: stringArgs[8] },
    });
  }
  if (stringArgs[10] !== COORDINATION_ALLOWED_TOOL_POLICY) {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_tool_policy_mismatch",
      fieldPath: "$.args[10]",
      message: "Wrapper tool policy must be coordination_only",
      details: { actual: stringArgs[10] },
    });
  }
  if (stringArgs[12] !== validatedJob.approved_paths.node_binary) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_node_binary_mismatch",
      fieldPath: "$.args[12]",
      message: "Inner node binary must match the approved node binary",
      details: { expected: validatedJob.approved_paths.node_binary, actual: stringArgs[12] },
    });
  }
  if (
    stringArgs[13].includes(`${path.sep}dist${path.sep}`) ||
    stringArgs[13].endsWith(`${path.sep}dist/openclaw.mjs`)
  ) {
    throw new CoordinationCommandContractValidationError({
      code: "dist_entrypoint_forbidden",
      fieldPath: "$.args[11]",
      message: "dist/openclaw.mjs is forbidden anywhere in the command contract",
      details: { actual: stringArgs[11] },
    });
  }
  if (stringArgs[13] !== COORDINATION_ENTRYPOINT_PATH) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_entrypoint_mismatch",
      fieldPath: "$.args[13]",
      message: "Inner entrypoint must be the approved source openclaw.mjs",
      details: { expected: COORDINATION_ENTRYPOINT_PATH, actual: stringArgs[13] },
    });
  }
  if (stringArgs[14] !== "agent-exec") {
    throw new CoordinationCommandContractValidationError({
      code: "inner_command_mismatch",
      fieldPath: "$.args[14]",
      message: "Inner command must be agent-exec",
      details: { actual: stringArgs[14] },
    });
  }
  if (stringArgs[16] !== COORDINATION_ALLOWED_AGENT) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_agent_mismatch",
      fieldPath: "$.args[16]",
      message: "Inner agent must be klaus",
      details: { actual: stringArgs[16] },
    });
  }
  if (stringArgs[18] !== validatedJob.id) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_job_id_mismatch",
      fieldPath: "$.args[18]",
      message: "Inner job id must match the wrapper job id and validated contract",
      details: { expected: validatedJob.id, actual: stringArgs[18] },
    });
  }
  const normalizedJobPath = assertJobPathWithinApprovedRoot(stringArgs[20], "$.args[20]");
  if (normalizedJobPath !== validatedJob.approval_scope.job_path) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_job_path_mismatch",
      fieldPath: "$.args[20]",
      message: "Inner job path must match the live validated job path",
      details: { expected: validatedJob.approval_scope.job_path, actual: normalizedJobPath },
    });
  }
  if (stringArgs[22] !== String(validatedJob.timeout_seconds)) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_timeout_mismatch",
      fieldPath: "$.args[22]",
      message: "Inner timeout must match the validated contract",
      details: { expected: String(validatedJob.timeout_seconds), actual: stringArgs[22] },
    });
  }
  if (stringArgs[23] !== "--tool-policy") {
    throw new CoordinationCommandContractValidationError({
      code: "inner_tool_policy_missing",
      fieldPath: "$.args[23]",
      message: "Inner --tool-policy is required",
      details: { actual: stringArgs[23] },
    });
  }
  if (stringArgs[24] !== COORDINATION_ALLOWED_TOOL_POLICY) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_tool_policy_mismatch",
      fieldPath: "$.args[24]",
      message: "Inner tool policy must be coordination_only and match the wrapper tool policy",
      details: {
        expected: COORDINATION_ALLOWED_TOOL_POLICY,
        actual: stringArgs[24],
        wrapper: stringArgs[10],
      },
    });
  }
  if (stringArgs[10] !== stringArgs[24]) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_tool_policy_mismatch",
      fieldPath: "$.args[24]",
      message: "Wrapper and inner tool policies must match",
      details: { wrapper: stringArgs[10], inner: stringArgs[24] },
    });
  }
  if (stringArgs[25] !== "--json") {
    throw new CoordinationCommandContractValidationError({
      code: "json_flag_missing",
      fieldPath: "$.args[25]",
      message: "--json is required",
      details: { actual: stringArgs[25] },
    });
  }

  for (let index = 0; index < expectedArgs.length; index += 1) {
    if (stringArgs[index] !== expectedArgs[index]) {
      const code = mapArgMismatchToCode(index);
      throw new CoordinationCommandContractValidationError({
        code,
        fieldPath: `$.args[${index}]`,
        message: `Rendered arg at index ${index} does not match the approved command contract`,
        details: { expected: expectedArgs[index], actual: stringArgs[index] },
      });
    }
  }

  return {
    env: {
      OPENCLAW_AGENT_EXEC_DEBUG: "1",
    },
    cwd,
    command,
    args: expectedArgs,
  };
}

function assertValidatedJobForCommandRendering(validatedJob: CoordinationJobContract): void {
  if (validatedJob.agent !== COORDINATION_ALLOWED_AGENT) {
    throw new CoordinationCommandContractValidationError({
      code: "unsafe_freeform_value",
      fieldPath: "validatedJob.agent",
      message: "Command rendering only accepts the validated Klaus coordination contract",
    });
  }
  if (validatedJob.tool_policy !== COORDINATION_ALLOWED_TOOL_POLICY) {
    throw new CoordinationCommandContractValidationError({
      code: "unsafe_freeform_value",
      fieldPath: "validatedJob.tool_policy",
      message: "Command rendering only accepts coordination_only tool policy",
    });
  }
  if (validatedJob.context?.tool_policy !== COORDINATION_ALLOWED_TOOL_POLICY) {
    throw new CoordinationCommandContractValidationError({
      code: "unsafe_freeform_value",
      fieldPath: "validatedJob.context.tool_policy",
      message: "Command rendering requires validated context.tool_policy=coordination_only",
    });
  }
  if (validatedJob.approved_paths.entrypoint !== COORDINATION_ENTRYPOINT_PATH) {
    throw new CoordinationCommandContractValidationError({
      code: "inner_entrypoint_mismatch",
      fieldPath: "validatedJob.approved_paths.entrypoint",
      message: "Validated job entrypoint must already be the approved source openclaw.mjs",
    });
  }
  if (validatedJob.approved_paths.safe_probe !== COORDINATION_SAFE_PROBE_PATH) {
    throw new CoordinationCommandContractValidationError({
      code: "safe_probe_path_invalid",
      fieldPath: "validatedJob.approved_paths.safe_probe",
      message: "Validated job safe-probe path must already match the approved path",
    });
  }
  assertApprovedNodeBinary(
    validatedJob.approved_paths.node_binary,
    "validatedJob.approved_paths.node_binary",
  );
  assertJobPathWithinApprovedRoot(
    validatedJob.approval_scope.job_path,
    "validatedJob.approval_scope.job_path",
  );
}

function expectPlainObject(value: unknown, fieldPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoordinationCommandContractValidationError({
      code: "invalid_rendered_command",
      fieldPath,
      message: `${fieldPath} must be an object`,
    });
  }
  return value as Record<string, unknown>;
}

function expectExactString<T extends string>(
  value: unknown,
  fieldPath: string,
  expected: T,
  code: "cwd_mismatch" | "command_mismatch",
): T {
  if (typeof value !== "string") {
    throw new CoordinationCommandContractValidationError({
      code: "invalid_rendered_command",
      fieldPath,
      message: `${fieldPath} must be a string`,
    });
  }
  if (value !== expected) {
    throw new CoordinationCommandContractValidationError({
      code,
      fieldPath,
      message: `${fieldPath} must exactly equal ${JSON.stringify(expected)}`,
      details: { expected, actual: value },
    });
  }
  return expected;
}

function expectApprovedAbsoluteNodeBinary(
  value: unknown,
  validatedJob: CoordinationJobContract,
  fieldPath: string,
): string {
  if (typeof value !== "string") {
    throw new CoordinationCommandContractValidationError({
      code: "invalid_rendered_command",
      fieldPath,
      message: `${fieldPath} must be a string`,
    });
  }
  assertApprovedNodeBinary(value, fieldPath);
  if (value !== validatedJob.approved_paths.node_binary) {
    throw new CoordinationCommandContractValidationError({
      code: "command_mismatch",
      fieldPath,
      message: `${fieldPath} must exactly equal the approved node binary`,
      details: { expected: validatedJob.approved_paths.node_binary, actual: value },
    });
  }
  return value;
}

function assertApprovedNodeBinary(nodeBinaryPath: string, fieldPath: string): string {
  if (!path.isAbsolute(nodeBinaryPath)) {
    throw new CoordinationCommandContractValidationError({
      code: "command_mismatch",
      fieldPath,
      message: `${fieldPath} must be an absolute node binary path`,
      details: { actual: nodeBinaryPath },
    });
  }
  if (path.basename(nodeBinaryPath) !== "node") {
    throw new CoordinationCommandContractValidationError({
      code: "command_mismatch",
      fieldPath,
      message: `${fieldPath} must resolve to the approved node executable`,
      details: { actual: nodeBinaryPath },
    });
  }
  return nodeBinaryPath;
}

function assertJobPathWithinApprovedRoot(jobPath: string, fieldPath: string): string {
  const normalized = path.normalize(jobPath);
  if (!path.isAbsolute(normalized)) {
    throw new CoordinationCommandContractValidationError({
      code: "job_path_outside_approved_root",
      fieldPath,
      message: `${fieldPath} must be an absolute path within the approved job root`,
      details: { actual: jobPath },
    });
  }
  const rootWithSep = `${COORDINATION_JOB_ROOT}${path.sep}`;
  if (normalized !== COORDINATION_JOB_ROOT && !normalized.startsWith(rootWithSep)) {
    throw new CoordinationCommandContractValidationError({
      code: "job_path_outside_approved_root",
      fieldPath,
      message: `${fieldPath} must stay within the approved coordination job root`,
      details: { approved_root: COORDINATION_JOB_ROOT, actual: normalized },
    });
  }
  return normalized;
}

function getApprovedSafeProbeResultPath(validatedJob: CoordinationJobContract): string {
  return path.join(path.dirname(validatedJob.approval_scope.job_path), "safe-probe-result.json");
}

function assertApprovedSafeProbeResultPath(
  resultPath: string,
  validatedJob: CoordinationJobContract,
  fieldPath: string,
): string {
  const normalized = path.normalize(resultPath);
  if (!path.isAbsolute(normalized)) {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_out_invalid",
      fieldPath,
      message: `${fieldPath} must be an absolute safe-probe result path`,
      details: { actual: resultPath },
    });
  }
  const approvedJobDir = path.dirname(validatedJob.approval_scope.job_path);
  const approvedPath = getApprovedSafeProbeResultPath(validatedJob);
  if (path.dirname(normalized) !== approvedJobDir || normalized !== approvedPath) {
    throw new CoordinationCommandContractValidationError({
      code: "wrapper_out_invalid",
      fieldPath,
      message: `${fieldPath} must stay within the approved job directory and equal safe-probe-result.json`,
      details: { approved_job_dir: approvedJobDir, expected: approvedPath, actual: normalized },
    });
  }
  return normalized;
}

function mapArgMismatchToCode(index: number): CoordinationCommandContractValidationErrorCode {
  switch (index) {
    case 0:
      return "safe_probe_wrapper_required";
    case 2:
      return "wrapper_job_id_mismatch";
    case 3:
      return "wrapper_out_missing";
    case 4:
      return "wrapper_out_invalid";
    case 5:
      return "wrapper_timeout_flag_missing";
    case 6:
      return "wrapper_timeout_mismatch";
    case 8:
      return "wrapper_agent_mismatch";
    case 10:
      return "wrapper_tool_policy_mismatch";
    case 12:
      return "inner_node_binary_mismatch";
    case 13:
      return "inner_entrypoint_mismatch";
    case 14:
      return "inner_command_mismatch";
    case 16:
      return "inner_agent_mismatch";
    case 18:
      return "inner_job_id_mismatch";
    case 20:
      return "inner_job_path_mismatch";
    case 22:
      return "inner_timeout_mismatch";
    case 23:
      return "inner_tool_policy_missing";
    case 25:
      return "json_flag_missing";
    default:
      return "extra_args_forbidden";
  }
}
