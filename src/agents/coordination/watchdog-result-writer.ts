import fs from "node:fs/promises";
import path from "node:path";
import {
  COORDINATION_ALLOWED_AGENT,
  COORDINATION_ALLOWED_JOB_TYPE,
  COORDINATION_JOB_ROOT,
  type CoordinationJobContract,
} from "./job-contract.js";
import type { CoordinationWatchdogResult } from "./watchdog-result.js";

const ALLOWED_STATUSES = new Set<CoordinationWatchdogResult["status"]>(["pass", "fail", "blocked"]);

export type CoordinationWatchdogResultWriteResult = {
  resultPath: string;
  bytesWritten: number;
  status: CoordinationWatchdogResult["status"];
  wrote: true;
};

export class CoordinationWatchdogResultWriterError extends Error {
  readonly code:
    | "invalid_job_id"
    | "path_escape"
    | "result_job_id_mismatch"
    | "result_agent_id_invalid"
    | "result_job_type_invalid"
    | "result_status_invalid"
    | "result_not_serializable"
    | "job_directory_missing"
    | "job_directory_not_directory"
    | "result_path_not_file"
    | "temp_cleanup_failed";

  constructor(
    code: CoordinationWatchdogResultWriterError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CoordinationWatchdogResultWriterError";
    this.code = code;
  }
}

export async function writeCoordinationWatchdogResult(
  validatedJob: CoordinationJobContract,
  result: CoordinationWatchdogResult,
): Promise<CoordinationWatchdogResultWriteResult> {
  const jobId = validateJobId(validatedJob.id);
  const jobDir = deriveApprovedJobDirectory(jobId);
  const resultPath = path.join(jobDir, "watchdog-result.json");
  const tempPath = path.join(
    jobDir,
    `.watchdog-result.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  if (result.job_id !== jobId) {
    throw new CoordinationWatchdogResultWriterError(
      "result_job_id_mismatch",
      "watchdog result job_id must exactly match the validated job id",
    );
  }

  if (result.agent_id !== COORDINATION_ALLOWED_AGENT) {
    throw new CoordinationWatchdogResultWriterError(
      "result_agent_id_invalid",
      "watchdog result agent_id must exactly equal klaus",
    );
  }

  if (result.job_type !== COORDINATION_ALLOWED_JOB_TYPE) {
    throw new CoordinationWatchdogResultWriterError(
      "result_job_type_invalid",
      "watchdog result job_type must exactly equal coordination_agent_probe",
    );
  }

  if (!ALLOWED_STATUSES.has(result.status)) {
    throw new CoordinationWatchdogResultWriterError(
      "result_status_invalid",
      "watchdog result status must be one of pass, fail, or blocked",
    );
  }

  let serialized: string;
  try {
    serialized = `${JSON.stringify(result, null, 2)}\n`;
  } catch (error) {
    throw new CoordinationWatchdogResultWriterError(
      "result_not_serializable",
      "watchdog result must be JSON-serializable",
      { cause: error },
    );
  }

  const payload = Buffer.from(serialized, "utf8");

  const directoryStats = await statExistingDirectory(jobDir);
  if (!directoryStats.isDirectory()) {
    throw new CoordinationWatchdogResultWriterError(
      "job_directory_not_directory",
      "validated job directory must be an existing directory",
    );
  }

  await assertExistingFileOrAbsent(resultPath);

  try {
    const handle = await fs.open(tempPath, "wx");
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tempPath, resultPath);
  } catch (error) {
    await cleanupTempFile(tempPath);
    throw error;
  }

  return {
    resultPath,
    bytesWritten: payload.byteLength,
    status: result.status,
    wrote: true,
  };
}

function validateJobId(jobId: string): string {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId)) {
    throw new CoordinationWatchdogResultWriterError(
      "invalid_job_id",
      "validated job id must be present and match /^[A-Za-z0-9][A-Za-z0-9._-]*$/",
    );
  }
  return jobId;
}

function deriveApprovedJobDirectory(jobId: string): string {
  const jobDir = path.resolve(COORDINATION_JOB_ROOT, jobId);
  const approvedRoot = path.resolve(COORDINATION_JOB_ROOT);
  const rootWithSep = `${approvedRoot}${path.sep}`;
  if (jobDir !== approvedRoot && !jobDir.startsWith(rootWithSep)) {
    throw new CoordinationWatchdogResultWriterError(
      "path_escape",
      "derived watchdog result path escaped the approved coordination job root",
    );
  }
  return jobDir;
}

async function statExistingDirectory(jobDir: string) {
  try {
    return await fs.stat(jobDir);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CoordinationWatchdogResultWriterError(
        "job_directory_missing",
        "validated job directory must already exist",
        { cause: error },
      );
    }
    throw error;
  }
}

async function assertExistingFileOrAbsent(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new CoordinationWatchdogResultWriterError(
        "result_path_not_file",
        "watchdog-result.json path must be a regular file when present",
      );
    }
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function cleanupTempFile(tempPath: string): Promise<void> {
  try {
    await fs.rm(tempPath, { force: true });
  } catch (error) {
    throw new CoordinationWatchdogResultWriterError(
      "temp_cleanup_failed",
      "failed to clean up watchdog result temp file after write failure",
      { cause: error },
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
