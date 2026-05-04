import { verifyCoordinationCleanup, type CoordinationCleanupEvidence } from "./cleanup-verifier.js";
import {
  type CoordinationRenderedCommand,
  CoordinationCommandContractValidationError,
  renderCoordinationCommand,
  validateRenderedCoordinationCommand,
} from "./command-contract.js";
import { validateCoordinationJobContract } from "./job-contract.js";
import { verifyCoordinationProofMarkers } from "./proof-verifier.js";
import { executeCoordinationSafeProbe } from "./safe-probe-execution-adapter.js";
import {
  writeCoordinationWatchdogResult,
  type CoordinationWatchdogResultWriteResult,
} from "./watchdog-result-writer.js";
import {
  buildCoordinationWatchdogResult,
  type CoordinationWatchdogResult,
} from "./watchdog-result.js";

export type CoordinationSafeProbeExecutionResult = {
  status: "completed" | "failed" | "timed_out" | "blocked";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  proofAttemptId?: string;
  wrapperSpawned?: boolean;
  innerOpenClawSpawned?: boolean;
  innerDebugEvidenceFound?: boolean;
  safeProbeSummary: string | Record<string, unknown>;
  parsedOutputSource?: "stdout" | "stderr" | "none" | "conflict";
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  artifactEvidence?: {
    job_json?: boolean;
    job_local_debug?: boolean;
    fallback_debug?: boolean;
    safe_probe_result?: boolean;
    agent_status_json?: boolean;
    agent_proof_json?: boolean;
    stdout_file?: boolean | "optional_not_produced";
    stderr_file?: boolean | "optional_not_produced";
  };
  debugEvents?: unknown[];
  cleanupEvidence?: CoordinationCleanupEvidence;
};

export type CoordinationWatchdogRunnerInput = {
  jobContractInput: unknown;
  jobPath: string;
  renderCommand?: (
    validatedJob: ReturnType<typeof validateCoordinationJobContract>,
  ) => CoordinationRenderedCommand;
  safeProbeExecution?: {
    run: (
      renderedCommand: CoordinationRenderedCommand,
    ) => Promise<CoordinationSafeProbeExecutionResult>;
  };
  useSafeProbeExecutionAdapter?: boolean;
  persistResult?: boolean;
};

export type CoordinationWatchdogRunnerOutput = {
  validatedJob: ReturnType<typeof validateCoordinationJobContract>;
  renderedCommand: CoordinationRenderedCommand;
  result: CoordinationWatchdogResult;
  resultWrite?: CoordinationWatchdogResultWriteResult;
};

export async function runCoordinationWatchdog(
  input: CoordinationWatchdogRunnerInput,
): Promise<CoordinationWatchdogRunnerOutput> {
  const startedAt = new Date().toISOString();
  const shouldPersistResult = input.persistResult === true;
  const shouldUseBuiltInSafeProbeAdapter = input.useSafeProbeExecutionAdapter === true;
  const validatedJob = validateCoordinationJobContract(input.jobContractInput, {
    jobPath: input.jobPath,
  });
  const renderedCommand = input.renderCommand
    ? input.renderCommand(validatedJob)
    : renderCoordinationCommand(validatedJob);

  let commandValidation: { status: "valid" | "invalid" | "unknown"; reason: string } | undefined;

  try {
    validateRenderedCoordinationCommand(renderedCommand, validatedJob);
    commandValidation = { status: "valid", reason: "command_contract_valid" };
  } catch (error) {
    if (error instanceof CoordinationCommandContractValidationError) {
      commandValidation = {
        status: "invalid",
        reason: `${error.code}:${error.fieldPath}`,
      };
    } else {
      commandValidation = {
        status: "invalid",
        reason: "command_contract_invalid:unknown_error",
      };
    }
  }

  if (commandValidation.status !== "valid") {
    const finishedAt = new Date().toISOString();
    const result = buildCoordinationWatchdogResult({
      validatedJob,
      commandValidation,
      artifactEvidence: {
        job_json: true,
        job_local_debug: false,
        fallback_debug: false,
        safe_probe_result: false,
        agent_status_json: false,
        agent_proof_json: false,
        stdout_file: false,
        stderr_file: false,
      },
      timing: {
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      },
      safeProbeSummary: "execution_not_started_command_contract_invalid",
      jobContractValid: true,
      approvalValid: true,
    });

    return finalizeCoordinationWatchdogRun({
      validatedJob,
      renderedCommand,
      result,
      shouldPersistResult,
    });
  }

  if (input.safeProbeExecution && shouldUseBuiltInSafeProbeAdapter) {
    const finishedAt = new Date().toISOString();
    const result = buildCoordinationWatchdogResult({
      validatedJob,
      commandValidation: {
        status: "unknown",
        reason: "conflicting_execution_adapter_configuration",
      },
      artifactEvidence: {
        job_json: true,
        job_local_debug: false,
        fallback_debug: false,
        safe_probe_result: false,
        agent_status_json: false,
        agent_proof_json: false,
        stdout_file: false,
        stderr_file: false,
      },
      timing: {
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      },
      safeProbeSummary: "execution_adapter_conflict",
      jobContractValid: true,
      approvalValid: true,
    });

    return finalizeCoordinationWatchdogRun({
      validatedJob,
      renderedCommand,
      result,
      shouldPersistResult,
    });
  }

  const selectedExecutionAdapter = input.safeProbeExecution
    ? input.safeProbeExecution
    : shouldUseBuiltInSafeProbeAdapter
      ? {
          run: (command: CoordinationRenderedCommand) =>
            executeCoordinationSafeProbe(validatedJob, command),
        }
      : undefined;

  if (!selectedExecutionAdapter) {
    const finishedAt = new Date().toISOString();
    const result = buildCoordinationWatchdogResult({
      validatedJob,
      commandValidation,
      artifactEvidence: {
        job_json: true,
        job_local_debug: false,
        fallback_debug: false,
        safe_probe_result: false,
        agent_status_json: false,
        agent_proof_json: false,
        stdout_file: false,
        stderr_file: false,
      },
      timing: {
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      },
      safeProbeSummary: "execution_adapter_missing",
      jobContractValid: true,
      approvalValid: true,
    });

    return finalizeCoordinationWatchdogRun({
      validatedJob,
      renderedCommand,
      result,
      shouldPersistResult,
    });
  }

  const execution = await selectedExecutionAdapter.run(renderedCommand);
  const normalizedArtifactEvidence = normalizeArtifactEvidence(execution.artifactEvidence);

  const proofVerification = Array.isArray(execution.debugEvents)
    ? verifyCoordinationProofMarkers(execution.debugEvents)
    : undefined;

  const normalizedArtifactEvidenceWithFallback = {
    ...normalizedArtifactEvidence,
    job_json: normalizedArtifactEvidence.job_json,
    job_local_debug:
      normalizedArtifactEvidence.job_local_debug || execution.innerDebugEvidenceFound === true,
    safe_probe_result: normalizedArtifactEvidence.safe_probe_result,
  };
  const cleanupVerification = execution.cleanupEvidence
    ? verifyCoordinationCleanup(execution.cleanupEvidence)
    : undefined;

  const timedOutOrFailedStatus =
    execution.status === "timed_out"
      ? "safe_probe_timed_out"
      : execution.status === "failed"
        ? "safe_probe_failed"
        : execution.status === "blocked"
          ? "safe_probe_blocked"
          : undefined;

  const result = buildCoordinationWatchdogResult({
    validatedJob,
    commandValidation:
      timedOutOrFailedStatus && commandValidation.status === "valid"
        ? { status: "unknown", reason: timedOutOrFailedStatus }
        : commandValidation,
    proofVerification,
    cleanupVerification,
    proofAttemptId: execution.proofAttemptId,
    artifactEvidence: normalizedArtifactEvidenceWithFallback,
    timing: {
      started_at: execution.started_at,
      finished_at: execution.finished_at,
      duration_ms: execution.duration_ms,
    },
    safeProbeSummary: execution.safeProbeSummary,
    parsedOutputSource: execution.parsedOutputSource,
    stdoutExcerpt: execution.stdoutExcerpt,
    stderrExcerpt: execution.stderrExcerpt,
    parsedArtifactEvidence: execution.artifactEvidence,
    parsedCleanupEvidence: execution.cleanupEvidence,
    jobContractValid: true,
    approvalValid: true,
  });

  return finalizeCoordinationWatchdogRun({
    validatedJob,
    renderedCommand,
    result,
    shouldPersistResult,
  });
}

function normalizeArtifactEvidence(
  artifactEvidence: CoordinationSafeProbeExecutionResult["artifactEvidence"],
): CoordinationWatchdogResult["artifacts_found"] {
  return {
    job_json: artifactEvidence?.job_json === true,
    job_local_debug: artifactEvidence?.job_local_debug === true,
    fallback_debug: artifactEvidence?.fallback_debug === true,
    safe_probe_result: artifactEvidence?.safe_probe_result === true,
    agent_status_json: artifactEvidence?.agent_status_json === true,
    agent_proof_json: artifactEvidence?.agent_proof_json === true,
    stdout_file: artifactEvidence?.stdout_file === true,
    stderr_file: artifactEvidence?.stderr_file === true,
  };
}

async function finalizeCoordinationWatchdogRun(params: {
  validatedJob: ReturnType<typeof validateCoordinationJobContract>;
  renderedCommand: CoordinationRenderedCommand;
  result: CoordinationWatchdogResult;
  shouldPersistResult: boolean;
}): Promise<CoordinationWatchdogRunnerOutput> {
  if (!params.shouldPersistResult) {
    return {
      validatedJob: params.validatedJob,
      renderedCommand: params.renderedCommand,
      result: params.result,
    };
  }

  const resultWrite = await writeCoordinationWatchdogResult(params.validatedJob, params.result);

  return {
    validatedJob: params.validatedJob,
    renderedCommand: params.renderedCommand,
    result: params.result,
    resultWrite,
  };
}
