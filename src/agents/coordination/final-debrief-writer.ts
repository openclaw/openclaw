import fs from "node:fs/promises";
import path from "node:path";
import {
  COORDINATION_WORK_AUTHORIZATION_ROOT,
  type CoordinationWorkAuthorizationContract,
} from "./work-authorization-contract.js";

const ALLOWED_DEBRIEF_STATUSES = new Set([
  "pass",
  "fail",
  "blocked",
  "ready_for_live_proof",
] as const);

export type CoordinationFinalDebrief = {
  schema_version: "v1";
  authorization_id: string;
  proof_attempt_id: string;
  objective_name: string;
  status: "pass" | "fail" | "blocked" | "ready_for_live_proof";
  started_at: string;
  finished_at: string;
  steps_attempted: string[];
  steps_completed: number;
  step_artifacts: string[];
  watchdog_result_paths: string[];
  files_changed_summary: string[];
  tests_run_summary: string[];
  proof_summary: string;
  blocker_reason: string | null;
  next_required_action: string | null;
  actual_percent_complete: number;
  human_summary: string;
};

export type CoordinationFinalDebriefWriteResult = {
  resultPath: string;
  bytesWritten: number;
  status: CoordinationFinalDebrief["status"];
  wrote: true;
};

export class CoordinationFinalDebriefWriterError extends Error {
  readonly code:
    | "invalid_authorization_id"
    | "authorization_id_mismatch"
    | "status_invalid"
    | "percent_invalid"
    | "path_escape"
    | "authorization_directory_missing"
    | "authorization_directory_not_directory"
    | "debrief_not_serializable";

  constructor(
    code: CoordinationFinalDebriefWriterError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CoordinationFinalDebriefWriterError";
    this.code = code;
  }
}

export async function writeCoordinationFinalDebrief(
  authorization: CoordinationWorkAuthorizationContract,
  debrief: CoordinationFinalDebrief,
): Promise<CoordinationFinalDebriefWriteResult> {
  const authorizationId = validateAuthorizationId(authorization.authorization_id);
  if (debrief.authorization_id !== authorizationId) {
    throw new CoordinationFinalDebriefWriterError(
      "authorization_id_mismatch",
      "final debrief authorization_id must exactly match the validated authorization id",
    );
  }
  if (!ALLOWED_DEBRIEF_STATUSES.has(debrief.status)) {
    throw new CoordinationFinalDebriefWriterError(
      "status_invalid",
      "final debrief status must be pass, fail, blocked, or ready_for_live_proof",
    );
  }
  if (
    typeof debrief.actual_percent_complete !== "number" ||
    !Number.isFinite(debrief.actual_percent_complete) ||
    debrief.actual_percent_complete < 0 ||
    debrief.actual_percent_complete > 100
  ) {
    throw new CoordinationFinalDebriefWriterError(
      "percent_invalid",
      "actual_percent_complete must be a number between 0 and 100",
    );
  }

  const authorizationDir = deriveAuthorizationDirectory(authorizationId);
  const resultPath = path.join(authorizationDir, "final-debrief.json");
  const tempPath = path.join(
    authorizationDir,
    `.final-debrief.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  let serialized: string;
  try {
    serialized = `${JSON.stringify(debrief, null, 2)}\n`;
  } catch (error) {
    throw new CoordinationFinalDebriefWriterError(
      "debrief_not_serializable",
      "final debrief must be JSON-serializable",
      { cause: error },
    );
  }

  const payload = Buffer.from(serialized, "utf8");
  const dirStats = await statExistingDirectory(authorizationDir);
  if (!dirStats.isDirectory()) {
    throw new CoordinationFinalDebriefWriterError(
      "authorization_directory_not_directory",
      "authorization directory must be an existing directory",
    );
  }

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
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  return {
    resultPath,
    bytesWritten: payload.byteLength,
    status: debrief.status,
    wrote: true,
  };
}

function validateAuthorizationId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new CoordinationFinalDebriefWriterError(
      "invalid_authorization_id",
      "authorization id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/",
    );
  }
  return value;
}

function deriveAuthorizationDirectory(authorizationId: string): string {
  const authorizationDir = path.resolve(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
  const approvedRoot = path.resolve(COORDINATION_WORK_AUTHORIZATION_ROOT);
  const rootWithSep = `${approvedRoot}${path.sep}`;
  if (authorizationDir !== approvedRoot && !authorizationDir.startsWith(rootWithSep)) {
    throw new CoordinationFinalDebriefWriterError(
      "path_escape",
      "derived final debrief path escaped the approved authorization root",
    );
  }
  return authorizationDir;
}

async function statExistingDirectory(dirPath: string) {
  try {
    return await fs.stat(dirPath);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new CoordinationFinalDebriefWriterError(
        "authorization_directory_missing",
        "authorization directory must already exist",
        { cause: error },
      );
    }
    throw error;
  }
}
