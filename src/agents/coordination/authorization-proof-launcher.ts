import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAuthorizationLoopWatchdogBridge,
  type CoordinationAuthorizationBridgeResult,
  type CoordinationAuthorizationBridgeStep,
} from "./authorization-loop-watchdog-bridge.js";
import { validateCoordinationWorkAuthorizationContract } from "./work-authorization-contract.js";

export type CoordinationAuthorizationProofLauncherInput = {
  authorizationPath: string;
  jobPath: string;
  proofAttemptId: string;
  actualPercentCompleteOnReady?: number;
  runBridge?: typeof runAuthorizationLoopWatchdogBridge;
};

export async function runCoordinationAuthorizationProofLauncher(
  input: CoordinationAuthorizationProofLauncherInput,
): Promise<CoordinationAuthorizationBridgeResult> {
  if (!input.proofAttemptId?.trim()) {
    throw new Error("proofAttemptId is required");
  }

  const authorization = validateCoordinationWorkAuthorizationContract(
    JSON.parse(await readFile(input.authorizationPath, "utf8")),
  );
  const jobContractInput = JSON.parse(await readFile(input.jobPath, "utf8"));

  const steps: CoordinationAuthorizationBridgeStep[] = [
    {
      step_id: "step-authorization-validated",
      step_name: "Validate work authorization artifact",
      planned_files: [input.authorizationPath],
      command_category: "validated_coordination_command_contract",
      proof_attempt_id: input.proofAttemptId,
      kind: "ordinary",
      execute: async () => ({
        step_id: "step-authorization-validated",
        proof_attempt_id: input.proofAttemptId,
        step_name: "Validate work authorization artifact",
        status: "pass",
        files_changed: [],
        commands_run: [],
        tests_run: [],
        artifacts_written: [input.authorizationPath],
        scope_check: { within_allowed_roots: true },
        proof_summary: "work authorization artifact loaded and validated",
        blocker_reason: null,
        next_step_recommendation: "continue_authorized_sequence",
      }),
    },
    {
      step_id: "step-job-contract-validated",
      step_name: "Validate live proof job contract artifact",
      planned_files: [input.jobPath],
      command_category: "validated_coordination_command_contract",
      proof_attempt_id: input.proofAttemptId,
      kind: "ordinary",
      execute: async () => ({
        step_id: "step-job-contract-validated",
        proof_attempt_id: input.proofAttemptId,
        step_name: "Validate live proof job contract artifact",
        status: "pass",
        files_changed: [],
        commands_run: [],
        tests_run: [],
        artifacts_written: [input.jobPath],
        scope_check: { within_allowed_roots: true },
        proof_summary: "live proof job contract loaded for structured watchdog execution",
        blocker_reason: null,
        next_step_recommendation: "continue_authorized_sequence",
      }),
    },
    {
      step_id: "step-live-watchdog-proof",
      step_name: "Run live authorization-layer coordination watchdog proof",
      planned_files: [
        input.jobPath,
        "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination/watchdog-runner.ts",
      ],
      command_category: "safe_probe_wrapped_coordination_job",
      proof_attempt_id: input.proofAttemptId,
      kind: "watchdog",
      watchdogInput: {
        jobContractInput,
        jobPath: input.jobPath,
        useSafeProbeExecutionAdapter: true,
        persistResult: true,
      },
    },
  ];

  const runBridge = input.runBridge ?? runAuthorizationLoopWatchdogBridge;
  return runBridge({
    authorization,
    steps,
    proofAttemptId: input.proofAttemptId,
    actualPercentCompleteOnReady: input.actualPercentCompleteOnReady,
  });
}

function printAuthorizationProofLauncherUsage(): void {
  console.log(
    "Usage: node --import tsx src/agents/coordination/authorization-proof-launcher.ts --work-authorization <path-to-work-authorization-dir-or-json> --attempt-id <proof-attempt-id>",
  );
}

async function resolveAuthorizationPathFromCli(inputPath: string): Promise<string> {
  const resolvedPath = path.resolve(inputPath);
  const stats = await stat(resolvedPath);
  if (stats.isDirectory()) {
    const candidate = path.join(resolvedPath, "work-authorization.json");
    const candidateStats = await stat(candidate).catch(() => null);
    if (!candidateStats?.isFile()) {
      throw new Error(
        `work authorization directory does not contain work-authorization.json: ${resolvedPath}`,
      );
    }
    return candidate;
  }
  if (!stats.isFile()) {
    throw new Error(`work authorization path is neither a file nor directory: ${resolvedPath}`);
  }
  if (path.extname(resolvedPath).toLowerCase() !== ".json") {
    throw new Error(`work authorization file must be a JSON file: ${resolvedPath}`);
  }
  return resolvedPath;
}

async function resolveJobPathFromAuthorization(authorizationPath: string): Promise<string> {
  const authorization = validateCoordinationWorkAuthorizationContract(
    JSON.parse(await readFile(authorizationPath, "utf8")),
  );
  const jobArtifactPattern = authorization.allowed_artifact_paths.find(
    (entry) =>
      entry.startsWith("/Users/corey-domidocs/clawd/runtime/agent-coordination/jobs/") &&
      !entry.endsWith("/job.json"),
  );
  const jobDirPattern = jobArtifactPattern?.replace(/\/\*\*$/, "");
  if (!jobDirPattern) {
    throw new Error(
      `unable to derive job path from authorization allowed_artifact_paths: ${authorizationPath}`,
    );
  }
  const jobPath = path.join(jobDirPattern, "job.json");
  const jobStats = await stat(jobPath).catch(() => null);
  if (!jobStats?.isFile()) {
    throw new Error(`derived job.json does not exist: ${jobPath}`);
  }
  return jobPath;
}

async function runAuthorizationProofLauncherCli(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    printAuthorizationProofLauncherUsage();
    return;
  }

  const workAuthorizationIndex = argv.indexOf("--work-authorization");
  const workAuthorizationValue =
    workAuthorizationIndex >= 0 ? argv[workAuthorizationIndex + 1] : undefined;
  const attemptIdIndex = argv.indexOf("--attempt-id");
  const attemptIdValue = attemptIdIndex >= 0 ? argv[attemptIdIndex + 1] : undefined;

  if (!workAuthorizationValue?.trim() || !attemptIdValue?.trim()) {
    if (!workAuthorizationValue?.trim() && !attemptIdValue?.trim()) {
      console.error("Missing required arguments: --work-authorization and --attempt-id");
    } else if (!workAuthorizationValue?.trim()) {
      console.error("Missing required argument: --work-authorization");
    } else {
      console.error("Missing required argument: --attempt-id");
    }
    process.exitCode = 1;
    return;
  }

  const authorizationPath = await resolveAuthorizationPathFromCli(workAuthorizationValue);
  const jobPath = await resolveJobPathFromAuthorization(authorizationPath);
  await runCoordinationAuthorizationProofLauncher({
    authorizationPath,
    jobPath,
    proofAttemptId: attemptIdValue,
  });
}

const isDirectExecution = (() => {
  if (!process.argv[1]) {
    return false;
  }
  const executedPath = path.resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  return executedPath === modulePath;
})();

if (isDirectExecution) {
  runAuthorizationProofLauncherCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`authorization proof launcher failed: ${message}`);
    process.exitCode = 1;
  });
}
