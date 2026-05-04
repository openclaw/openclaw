import fs from "node:fs/promises";
import path from "node:path";
import { COORDINATION_JOB_ROOT, type CoordinationJobContract } from "./job-contract.js";
import {
  runCoordinationWatchdog,
  type CoordinationWatchdogRunnerOutput,
} from "./watchdog-runner.js";

export class CoordinationWatchdogJobFileError extends Error {
  readonly code:
    | "job_path_missing"
    | "job_file_name_invalid"
    | "job_path_outside_root"
    | "job_file_unreadable"
    | "job_file_invalid_json";

  constructor(
    code: CoordinationWatchdogJobFileError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CoordinationWatchdogJobFileError";
    this.code = code;
  }
}

export async function runCoordinationWatchdogFromJobFile(
  jobPath: string,
  options?: {
    readFile?: typeof fs.readFile;
    runWatchdog?: typeof runCoordinationWatchdog;
  },
): Promise<CoordinationWatchdogRunnerOutput> {
  const validatedJobPath = validateJobFilePath(jobPath);
  const readFile = options?.readFile ?? fs.readFile;
  const runWatchdog = options?.runWatchdog ?? runCoordinationWatchdog;

  let rawJobFile: string;
  try {
    rawJobFile = await readFile(validatedJobPath, "utf8");
  } catch (error) {
    throw new CoordinationWatchdogJobFileError(
      "job_file_unreadable",
      "coordination watchdog job file could not be read",
      { cause: error },
    );
  }

  let jobContractInput: CoordinationJobContract;
  try {
    jobContractInput = JSON.parse(rawJobFile) as CoordinationJobContract;
  } catch (error) {
    throw new CoordinationWatchdogJobFileError(
      "job_file_invalid_json",
      "coordination watchdog job file must contain valid JSON",
      { cause: error },
    );
  }

  return runWatchdog({
    jobContractInput,
    jobPath: validatedJobPath,
    useSafeProbeExecutionAdapter: true,
    persistResult: true,
  });
}

function validateJobFilePath(jobPath: string): string {
  if (typeof jobPath !== "string" || jobPath.trim().length === 0) {
    throw new CoordinationWatchdogJobFileError(
      "job_path_missing",
      "coordination watchdog requires an explicit job.json path",
    );
  }

  const normalized = path.resolve(jobPath);
  if (path.basename(normalized) !== "job.json") {
    throw new CoordinationWatchdogJobFileError(
      "job_file_name_invalid",
      "coordination watchdog path must end with job.json",
    );
  }

  const approvedRoot = path.resolve(COORDINATION_JOB_ROOT);
  const rootWithSep = `${approvedRoot}${path.sep}`;
  if (normalized !== approvedRoot && !normalized.startsWith(rootWithSep)) {
    throw new CoordinationWatchdogJobFileError(
      "job_path_outside_root",
      "coordination watchdog job path must stay within the approved coordination job root",
    );
  }

  return normalized;
}
