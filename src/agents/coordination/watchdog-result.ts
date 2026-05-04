import path from "node:path";
import type { CoordinationCleanupVerificationResult } from "./cleanup-verifier.js";
import { COORDINATION_JOB_ROOT, type CoordinationJobContract } from "./job-contract.js";
import type { CoordinationProofVerificationResult } from "./proof-verifier.js";

export type CoordinationWatchdogArtifactEvidence = {
  job_json: boolean | "unknown";
  job_local_debug: boolean | "unknown";
  fallback_debug: boolean | "unknown";
  safe_probe_result: boolean | "unknown";
  agent_status_json: boolean | "unknown";
  agent_proof_json: boolean | "unknown";
  stdout_file: boolean | "unknown";
  stderr_file: boolean | "unknown";
};

export type CoordinationWatchdogTiming = {
  started_at: string;
  finished_at: string;
  duration_ms: number;
};

export type CoordinationCommandValidationSummary = {
  status: "valid" | "invalid" | "unknown";
  reason: string;
};

export type CoordinationWatchdogResultInput = {
  validatedJob: CoordinationJobContract;
  proofAttemptId?: string;
  commandValidation?: CoordinationCommandValidationSummary;
  proofVerification?: CoordinationProofVerificationResult;
  cleanupVerification?: CoordinationCleanupVerificationResult;
  artifactEvidence: CoordinationWatchdogArtifactEvidence;
  timing: CoordinationWatchdogTiming;
  safeProbeSummary: string | Record<string, unknown>;
  parsedOutputSource?: "stdout" | "stderr" | "file" | "none" | "conflict";
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  parsedArtifactEvidence?: Record<string, unknown>;
  parsedCleanupEvidence?: Record<string, unknown>;
  jobContractValid: boolean | "unknown";
  approvalValid: boolean | "unknown";
};

export type CoordinationWatchdogResult = {
  schema_version: "v1";
  proof_attempt_id?: string;
  job_id: string;
  agent_id: "klaus";
  job_type: "coordination_agent_probe";
  status: "pass" | "fail" | "blocked";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  command_contract_valid: boolean;
  job_contract_valid: boolean;
  approval_valid: boolean;
  artifacts_found: {
    job_json: boolean;
    job_local_debug: boolean;
    fallback_debug: boolean;
    safe_probe_result: boolean;
    agent_status_json: boolean;
    agent_proof_json: boolean;
    stdout_file: boolean;
    stderr_file: boolean;
  };
  parsed_output_source?: "stdout" | "stderr" | "file" | "none" | "conflict";
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  parsed_artifact_evidence?: Record<string, unknown>;
  parsed_cleanup_evidence?: Record<string, unknown>;
  required_markers_present: string[];
  forbidden_markers_found: string[];
  cleanup_result: {
    no_stale_lock: boolean;
    no_orphan_openclaw_children: boolean;
    no_mcp_remote: boolean;
    no_zapier_process: boolean;
    no_proof_tied_slack_runtime: boolean;
  };
  classification_reason: string;
  human_summary: string;
  raw_safe_probe_result_path_or_inline_summary: string | Record<string, unknown>;
};

export function getCoordinationWatchdogResultPath(validatedJob: CoordinationJobContract): string {
  const jobPath = path.normalize(validatedJob.approval_scope.job_path);
  const jobDir = path.dirname(jobPath);
  const rootWithSep = `${COORDINATION_JOB_ROOT}${path.sep}`;
  if (jobDir !== COORDINATION_JOB_ROOT && !jobDir.startsWith(rootWithSep)) {
    throw new Error("watchdog result path must resolve under the approved coordination job root");
  }
  return path.join(jobDir, "watchdog-result.json");
}

export function buildCoordinationWatchdogResult(
  input: CoordinationWatchdogResultInput,
): CoordinationWatchdogResult {
  const artifacts = normalizeArtifacts(input.artifactEvidence);
  const proof = input.proofVerification;
  const cleanup = input.cleanupVerification;
  const commandValid = input.commandValidation?.status === "valid";
  const commandKnownInvalid = input.commandValidation?.status === "invalid";
  const commandUnknown = !input.commandValidation || input.commandValidation.status === "unknown";
  const jobContractValid = input.jobContractValid === true;
  const approvalValid = input.approvalValid === true;
  const jobJsonRequiredPresent = artifacts.job_json;
  const safeProbeRequiredPresent = artifacts.safe_probe_result;
  const jobDebugRequiredPresent = artifacts.job_local_debug;
  const forbiddenMarkersFound = proof?.forbiddenMarkersFound ?? [];
  const cleanupBooleans = {
    no_stale_lock: cleanup?.noStaleLock === true,
    no_orphan_openclaw_children: cleanup?.noOrphanOpenClawChildren === true,
    no_mcp_remote: cleanup?.noProofTiedMcpRemote === true,
    no_zapier_process: cleanup?.noProofTiedZapierProcess === true,
    no_proof_tied_slack_runtime: cleanup?.noProofTiedSlackRuntime === true,
  };

  let status: "pass" | "fail" | "blocked";
  let classificationReason: string;

  const provenFailure =
    commandKnownInvalid ||
    forbiddenMarkersFound.length > 0 ||
    proof?.status === "fail" ||
    cleanup?.status === "fail";

  if (provenFailure) {
    status = "fail";
    classificationReason =
      firstDefined(
        forbiddenMarkersFound[0] ? `forbidden_marker:${forbiddenMarkersFound[0]}` : undefined,
        proof?.status === "fail" ? `proof_fail:${proof.classificationReason}` : undefined,
        cleanup?.status === "fail" ? `cleanup_fail:${cleanup.classificationReason}` : undefined,
        commandKnownInvalid && input.commandValidation
          ? `command_invalid:${input.commandValidation.reason}`
          : undefined,
      ) ?? "proven_safety_violation";
  } else {
    const passEligible =
      jobContractValid &&
      approvalValid &&
      commandValid &&
      jobJsonRequiredPresent &&
      safeProbeRequiredPresent &&
      jobDebugRequiredPresent &&
      proof?.status === "pass" &&
      cleanup?.status === "pass" &&
      forbiddenMarkersFound.length === 0 &&
      cleanupBooleans.no_stale_lock &&
      cleanupBooleans.no_orphan_openclaw_children &&
      cleanupBooleans.no_mcp_remote &&
      cleanupBooleans.no_zapier_process &&
      cleanupBooleans.no_proof_tied_slack_runtime;

    if (passEligible) {
      status = "pass";
      classificationReason = "all_required_contract_proof_and_cleanup_gates_passed";
    } else {
      status = "blocked";
      classificationReason =
        firstDefined(
          !jobContractValid ? "job_contract_invalid_or_unknown" : undefined,
          !approvalValid ? "approval_invalid_or_unknown" : undefined,
          commandUnknown && input.parsedOutputSource === "conflict"
            ? "safe_probe_output_conflict"
            : undefined,
          !jobJsonRequiredPresent ? "job_json_missing_or_ambiguous" : undefined,
          !jobDebugRequiredPresent ? "job_local_debug_missing_or_ambiguous" : undefined,
          !proof ? "proof_verification_missing" : undefined,
          proof?.status === "blocked" ? `proof_blocked:${proof.classificationReason}` : undefined,
          !safeProbeRequiredPresent ? "safe_probe_result_missing" : undefined,
          !cleanup ? "cleanup_verification_missing" : undefined,
          cleanup?.status === "blocked"
            ? `cleanup_blocked:${cleanup.classificationReason}`
            : undefined,
          commandUnknown && input.parsedOutputSource !== "conflict"
            ? "command_contract_unknown"
            : undefined,
          !commandValid ? "command_contract_not_valid" : undefined,
          "artifact_evidence_incomplete_or_ambiguous",
        ) ?? "artifact_evidence_incomplete_or_ambiguous";
    }
  }

  return {
    schema_version: "v1",
    proof_attempt_id: input.proofAttemptId,
    job_id: input.validatedJob.id,
    agent_id: input.validatedJob.agent,
    job_type: input.validatedJob.job_type,
    status,
    started_at: input.timing.started_at,
    finished_at: input.timing.finished_at,
    duration_ms: input.timing.duration_ms,
    command_contract_valid: commandValid,
    job_contract_valid: jobContractValid,
    approval_valid: approvalValid,
    artifacts_found: artifacts,
    parsed_output_source: input.parsedOutputSource,
    stdout_excerpt: input.stdoutExcerpt,
    stderr_excerpt: input.stderrExcerpt,
    parsed_artifact_evidence: input.parsedArtifactEvidence,
    parsed_cleanup_evidence: input.parsedCleanupEvidence,
    required_markers_present: proof?.requiredMarkersPresent ?? [],
    forbidden_markers_found: forbiddenMarkersFound,
    cleanup_result: cleanupBooleans,
    classification_reason: classificationReason,
    human_summary: buildHumanSummary({
      status,
      jobId: input.validatedJob.id,
      proof,
      cleanup,
      commandValidation: input.commandValidation,
      artifacts,
    }),
    raw_safe_probe_result_path_or_inline_summary: input.safeProbeSummary,
  };
}

export function serializeCoordinationWatchdogResult(result: CoordinationWatchdogResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function normalizeArtifacts(
  evidence: CoordinationWatchdogArtifactEvidence,
): CoordinationWatchdogResult["artifacts_found"] {
  return {
    job_json: evidence.job_json === true,
    job_local_debug: evidence.job_local_debug === true,
    fallback_debug: evidence.fallback_debug === true,
    safe_probe_result: evidence.safe_probe_result === true,
    agent_status_json: evidence.agent_status_json === true,
    agent_proof_json: evidence.agent_proof_json === true,
    stdout_file: evidence.stdout_file === true,
    stderr_file: evidence.stderr_file === true,
  };
}

function buildHumanSummary(params: {
  status: "pass" | "fail" | "blocked";
  jobId: string;
  proof?: CoordinationProofVerificationResult;
  cleanup?: CoordinationCleanupVerificationResult;
  commandValidation?: CoordinationCommandValidationSummary;
  artifacts: CoordinationWatchdogResult["artifacts_found"];
}): string {
  if (params.status === "pass") {
    return `Coordination watchdog verification passed for ${params.jobId}: command contract valid, required proof markers present, no forbidden markers found, and cleanup passed.`;
  }
  if (params.status === "fail") {
    return `Coordination watchdog verification failed for ${params.jobId}: a proven contract, proof, or cleanup safety violation was found.`;
  }
  return `Coordination watchdog verification is blocked for ${params.jobId}: evidence is incomplete or ambiguous, so success cannot be claimed.`;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}
