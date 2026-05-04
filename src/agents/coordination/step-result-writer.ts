import fs from "node:fs/promises";
import path from "node:path";
import {
  COORDINATION_WORK_AUTHORIZATION_ROOT,
  type CoordinationWorkAuthorizationContract,
} from "./work-authorization-contract.js";

const ALLOWED_STEP_STATUSES = new Set(["pass", "fail", "blocked"] as const);

export type CoordinationStepResult = {
  step_id: string;
  authorization_id: string;
  proof_attempt_id: string;
  step_name: string;
  status: "pass" | "fail" | "blocked";
  files_changed: string[];
  commands_run: string[];
  tests_run: Array<{ command: string; result: "pass" | "fail" | "blocked" }>;
  artifacts_written: string[];
  scope_check: Record<string, unknown>;
  proof_summary: string;
  blocker_reason: string | null;
  next_step_recommendation: string | null;
};

export type CoordinationStepResultWriteResult = {
  resultPath: string;
  bytesWritten: number;
  status: CoordinationStepResult["status"];
  wrote: true;
};

export class CoordinationStepResultWriterError extends Error {
  readonly code:
    | "invalid_authorization_id"
    | "invalid_step_id"
    | "path_escape"
    | "authorization_id_mismatch"
    | "step_status_invalid"
    | "result_not_serializable"
    | "steps_directory_missing"
    | "steps_directory_not_directory";

  constructor(
    code: CoordinationStepResultWriterError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CoordinationStepResultWriterError";
    this.code = code;
  }
}

export async function writeCoordinationStepResult(
  authorization: CoordinationWorkAuthorizationContract,
  result: CoordinationStepResult,
): Promise<CoordinationStepResultWriteResult> {
  const authorizationId = validateIdentifier(
    authorization.authorization_id,
    "invalid_authorization_id",
  );
  const stepId = validateIdentifier(result.step_id, "invalid_step_id");

  if (result.authorization_id !== authorizationId) {
    throw new CoordinationStepResultWriterError(
      "authorization_id_mismatch",
      "step result authorization_id must exactly match the validated authorization id",
    );
  }

  if (!ALLOWED_STEP_STATUSES.has(result.status)) {
    throw new CoordinationStepResultWriterError(
      "step_status_invalid",
      "step result status must be one of pass, fail, or blocked",
    );
  }

  const stepsDir = deriveStepsDirectory(authorizationId);
  const resultPath = path.join(stepsDir, `${stepId}.json`);
  const tempPath = path.join(
    stepsDir,
    `.${stepId}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  let serialized: string;
  try {
    serialized = `${JSON.stringify(result, null, 2)}\n`;
  } catch (error) {
    throw new CoordinationStepResultWriterError(
      "result_not_serializable",
      "step result must be JSON-serializable",
      { cause: error },
    );
  }

  const payload = Buffer.from(serialized, "utf8");
  const dirStats = await statExistingDirectory(stepsDir);
  if (!dirStats.isDirectory()) {
    throw new CoordinationStepResultWriterError(
      "steps_directory_not_directory",
      "authorization steps directory must be an existing directory",
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
    status: result.status,
    wrote: true,
  };
}

function deriveStepsDirectory(authorizationId: string): string {
  const authorizationDir = path.resolve(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
  const approvedRoot = path.resolve(COORDINATION_WORK_AUTHORIZATION_ROOT);
  const rootWithSep = `${approvedRoot}${path.sep}`;
  if (authorizationDir !== approvedRoot && !authorizationDir.startsWith(rootWithSep)) {
    throw new CoordinationStepResultWriterError(
      "path_escape",
      "derived step result path escaped the approved work-authorization root",
    );
  }
  return path.join(authorizationDir, "steps");
}

function validateIdentifier(
  value: string,
  code: "invalid_authorization_id" | "invalid_step_id",
): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new CoordinationStepResultWriterError(
      code,
      `${code === "invalid_authorization_id" ? "authorization" : "step"} id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/`,
    );
  }
  return value;
}

async function statExistingDirectory(dirPath: string) {
  try {
    return await fs.stat(dirPath);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new CoordinationStepResultWriterError(
        "steps_directory_missing",
        "authorization steps directory must already exist",
        { cause: error },
      );
    }
    throw error;
  }
}
