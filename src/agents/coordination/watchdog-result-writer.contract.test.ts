import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COORDINATION_ALLOWED_AGENT,
  COORDINATION_ALLOWED_APPROVAL_MODE,
  COORDINATION_ALLOWED_JOB_TYPE,
  COORDINATION_ALLOWED_TOOL_POLICY,
  COORDINATION_ENTRYPOINT_PATH,
  COORDINATION_JOB_ROOT,
  COORDINATION_JOB_SCHEMA_VERSION,
  COORDINATION_MAX_RETRIES,
  COORDINATION_REPO_ROOT,
  COORDINATION_REQUIRED_APPROVAL_STATEMENT,
  COORDINATION_REQUIRED_APPROVER,
  COORDINATION_REQUIRED_EXECUTION_MODE,
  COORDINATION_SAFE_PROBE_PATH,
  validateCoordinationJobContract,
} from "./job-contract.js";
import { writeCoordinationWatchdogResult } from "./watchdog-result-writer.js";
import type { CoordinationWatchdogResult } from "./watchdog-result.js";

const createdJobDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdJobDirs.splice(0).map((jobDir) => fs.rm(jobDir, { recursive: true, force: true })),
  );
});

async function makeJobDir(
  jobId = `watchdog-result-writer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
) {
  const jobDir = path.join(COORDINATION_JOB_ROOT, jobId);
  createdJobDirs.push(jobDir);
  await fs.rm(jobDir, { recursive: true, force: true });
  return { jobId, jobDir };
}

function createValidatedJob(jobId: string) {
  const jobPath = `${COORDINATION_JOB_ROOT}/${jobId}/job.json`;
  return validateCoordinationJobContract(
    {
      schema_version: COORDINATION_JOB_SCHEMA_VERSION,
      id: jobId,
      created_at: "2026-04-28T04:20:00.000Z",
      approval_mode: COORDINATION_ALLOWED_APPROVAL_MODE,
      approved_by: COORDINATION_REQUIRED_APPROVER,
      approval_statement: COORDINATION_REQUIRED_APPROVAL_STATEMENT,
      approval_scope: {
        job_id: jobId,
        agent_id: COORDINATION_ALLOWED_AGENT,
        job_type: COORDINATION_ALLOWED_JOB_TYPE,
        tool_policy: COORDINATION_ALLOWED_TOOL_POLICY,
        timeout_seconds: 30,
        entrypoint: COORDINATION_ENTRYPOINT_PATH,
        job_path: jobPath,
      },
      agent: COORDINATION_ALLOWED_AGENT,
      tool_policy: COORDINATION_ALLOWED_TOOL_POLICY,
      context: {
        tool_policy: COORDINATION_ALLOWED_TOOL_POLICY,
      },
      execution_mode: COORDINATION_REQUIRED_EXECUTION_MODE,
      job_type: COORDINATION_ALLOWED_JOB_TYPE,
      intent_summary: "Write a standalone watchdog result.",
      allowed_actions: ["write_watchdog_result"],
      forbidden_actions: ["write_job_json"],
      approved_paths: {
        repo_root: COORDINATION_REPO_ROOT,
        job_root: COORDINATION_JOB_ROOT,
        entrypoint: COORDINATION_ENTRYPOINT_PATH,
        safe_probe: COORDINATION_SAFE_PROBE_PATH,
        node_binary: "/usr/local/bin/node",
      },
      timeout_seconds: 30,
      max_retries: COORDINATION_MAX_RETRIES,
      expected_markers: ["action_handler_expected"],
      forbidden_markers: ["forbidden"],
      cleanup_requirements: {
        require_no_stale_lock: true,
        require_no_orphan_openclaw_children: true,
        require_no_mcp_remote: true,
        require_no_zapier_process: true,
        require_no_proof_tied_slack_runtime: true,
      },
    },
    { jobPath },
  );
}

function createResult(jobId: string): CoordinationWatchdogResult {
  return {
    schema_version: "v1",
    job_id: jobId,
    agent_id: "klaus",
    job_type: "coordination_agent_probe",
    status: "pass",
    started_at: "2026-04-28T04:20:01.000Z",
    finished_at: "2026-04-28T04:20:31.000Z",
    duration_ms: 30000,
    command_contract_valid: true,
    job_contract_valid: true,
    approval_valid: true,
    artifacts_found: {
      job_json: true,
      job_local_debug: true,
      fallback_debug: false,
      safe_probe_result: true,
      agent_status_json: false,
      agent_proof_json: false,
      stdout_file: false,
      stderr_file: false,
    },
    required_markers_present: ["action_handler_expected"],
    forbidden_markers_found: [],
    cleanup_result: {
      no_stale_lock: true,
      no_orphan_openclaw_children: true,
      no_mcp_remote: true,
      no_zapier_process: true,
      no_proof_tied_slack_runtime: true,
    },
    classification_reason: "ok",
    human_summary: "ok",
    raw_safe_probe_result_path_or_inline_summary: { timed_out: true },
  };
}

describe("writeCoordinationWatchdogResult", () => {
  it("valid watchdog result writes watchdog-result.json", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });

    const validatedJob = createValidatedJob(jobId);
    const result = createResult(jobId);

    const writeResult = await writeCoordinationWatchdogResult(validatedJob, result);
    const resultPath = path.join(jobDir, "watchdog-result.json");
    const written = await fs.readFile(resultPath, "utf8");

    expect(writeResult).toMatchObject({
      resultPath,
      status: "pass",
      wrote: true,
    });
    expect(writeResult.bytesWritten).toBe(Buffer.byteLength(written, "utf8"));
  });

  it("writer refuses job id mismatch", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });
    const validatedJob = createValidatedJob(jobId);

    await expect(
      writeCoordinationWatchdogResult(validatedJob, createResult("different-job")),
    ).rejects.toMatchObject({
      code: "result_job_id_mismatch",
    });
  });

  it("writer refuses wrong agent_id", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });
    const validatedJob = createValidatedJob(jobId);
    const result = { ...createResult(jobId), agent_id: "dom" as "klaus" };

    await expect(writeCoordinationWatchdogResult(validatedJob, result)).rejects.toMatchObject({
      code: "result_agent_id_invalid",
    });
  });

  it("writer refuses wrong job_type", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });
    const validatedJob = createValidatedJob(jobId);
    const result = {
      ...createResult(jobId),
      job_type: "other_job" as CoordinationWatchdogResult["job_type"],
    };

    await expect(writeCoordinationWatchdogResult(validatedJob, result)).rejects.toMatchObject({
      code: "result_job_type_invalid",
    });
  });

  it("writer refuses invalid status", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });
    const validatedJob = createValidatedJob(jobId);
    const result = {
      ...createResult(jobId),
      status: "maybe" as CoordinationWatchdogResult["status"],
    };

    await expect(writeCoordinationWatchdogResult(validatedJob, result)).rejects.toMatchObject({
      code: "result_status_invalid",
    });
  });

  it("writer refuses path escape", async () => {
    const escapedValidatedJob = {
      ...createValidatedJob((await makeJobDir()).jobId),
      id: "../escape",
    };

    await expect(
      writeCoordinationWatchdogResult(escapedValidatedJob, createResult("../escape")),
    ).rejects.toMatchObject({ code: "invalid_job_id" });
  });

  it("writer refuses missing job directory", async () => {
    const { jobId } = await makeJobDir();
    const validatedJob = createValidatedJob(jobId);

    await expect(
      writeCoordinationWatchdogResult(validatedJob, createResult(jobId)),
    ).rejects.toMatchObject({ code: "job_directory_missing" });
  });

  it("writer does not create parent directories", async () => {
    const { jobId, jobDir } = await makeJobDir();
    const validatedJob = createValidatedJob(jobId);

    await expect(
      writeCoordinationWatchdogResult(validatedJob, createResult(jobId)),
    ).rejects.toMatchObject({ code: "job_directory_missing" });

    await expect(fs.stat(jobDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writer writes only watchdog-result.json, aside from a same-directory temp file during atomic write", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, "job.json"), "{}\n");
    await fs.writeFile(path.join(jobDir, ".agent-exec-debug.jsonl"), "debug\n");

    const validatedJob = createValidatedJob(jobId);
    await writeCoordinationWatchdogResult(validatedJob, createResult(jobId));

    const entries = (await fs.readdir(jobDir)).toSorted();
    expect(entries).toEqual([".agent-exec-debug.jsonl", "job.json", "watchdog-result.json"]);
  });

  it("writer refuses non-JSON-serializable result", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });
    const validatedJob = createValidatedJob(jobId);
    const result = createResult(jobId) as CoordinationWatchdogResult & {
      raw_safe_probe_result_path_or_inline_summary: Record<string, unknown>;
    };
    result.raw_safe_probe_result_path_or_inline_summary = {};
    result.raw_safe_probe_result_path_or_inline_summary.self =
      result.raw_safe_probe_result_path_or_inline_summary;

    await expect(writeCoordinationWatchdogResult(validatedJob, result)).rejects.toMatchObject({
      code: "result_not_serializable",
    });
  });

  it("writer output is readable JSON and round-trips correctly", async () => {
    const { jobId, jobDir } = await makeJobDir();
    await fs.mkdir(jobDir, { recursive: true });
    const validatedJob = createValidatedJob(jobId);
    const result = createResult(jobId);

    await writeCoordinationWatchdogResult(validatedJob, result);
    const written = await fs.readFile(path.join(jobDir, "watchdog-result.json"), "utf8");

    expect(JSON.parse(written)).toEqual(result);
  });
});
