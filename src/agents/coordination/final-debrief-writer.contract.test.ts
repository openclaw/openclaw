import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCoordinationFinalDebrief } from "./final-debrief-writer.js";
import {
  COORDINATION_WORK_AUTHORIZATION_ROOT,
  validateCoordinationWorkAuthorizationContract,
} from "./work-authorization-contract.js";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function createAuthorization(authorizationId: string) {
  return validateCoordinationWorkAuthorizationContract({
    schema_version: "v1",
    authorization_id: authorizationId,
    objective_name: "Complete bounded loop",
    approved_by: "corey",
    approval_mode: "explicit_corey_bounded_objective_approval",
    approval_statement: "Corey approved the bounded objective.",
    created_at: "2026-04-28T17:20:00.000Z",
    allowed_repo_root: "/Users/corey-domidocs/src/openclaw-2026.4.21",
    allowed_work_roots: [
      "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination",
      "/Users/corey-domidocs/clawd/runtime/agent-coordination",
    ],
    allowed_files: [],
    allowed_file_patterns: [
      "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination/**",
      "/Users/corey-domidocs/clawd/runtime/agent-coordination/**",
    ],
    allowed_commands: [
      {
        category: "narrow_coordination_test",
        command: "pnpm test -- src/agents/coordination/final-debrief-writer.contract.test.ts",
      },
    ],
    allowed_test_commands: [
      "pnpm test -- src/agents/coordination/final-debrief-writer.contract.test.ts",
    ],
    allowed_artifact_paths: [
      `/Users/corey-domidocs/clawd/runtime/agent-coordination/work-authorizations/${authorizationId}/final-debrief.json`,
    ],
    allowed_agents: ["dom", "klaus"],
    allowed_job_types: ["coordination_agent_probe"],
    allowed_execution_modes: ["safe_probe_wrapped_agent_exec"],
    max_runtime_steps: 3,
    max_retries_per_step: 0,
    forbidden_surfaces: ["slack"],
    stop_conditions: ["proof_failed"],
    proof_requirements: { require_final_debrief: true },
    completion_definition: { final_debrief_required: true },
  });
}

function createDebrief(authorizationId: string) {
  return {
    schema_version: "v1" as const,
    authorization_id: authorizationId,
    proof_attempt_id: "attempt-004",
    objective_name: "Complete bounded loop",
    status: "ready_for_live_proof" as const,
    started_at: "2026-04-28T17:20:00.000Z",
    finished_at: "2026-04-28T17:30:00.000Z",
    steps_attempted: ["step-1"],
    steps_completed: 1,
    step_artifacts: ["/tmp/step-1.json"],
    watchdog_result_paths: ["/tmp/watchdog-result.json"],
    files_changed_summary: ["coordination/a.ts"],
    tests_run_summary: [
      "pnpm test -- src/agents/coordination/final-debrief-writer.contract.test.ts",
    ],
    proof_summary: "ready",
    blocker_reason: null,
    next_required_action: "Request live proof approval",
    actual_percent_complete: 88,
    human_summary: "Ready for live proof approval.",
  };
}

describe("writeCoordinationFinalDebrief", () => {
  it("final debrief writer writes only inside authorization directory", async () => {
    const authorizationId = `auth-${Date.now()}`;
    const authorizationDir = path.join(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
    createdDirs.push(authorizationDir);
    await fs.mkdir(authorizationDir, { recursive: true });

    const result = await writeCoordinationFinalDebrief(
      createAuthorization(authorizationId),
      createDebrief(authorizationId),
    );

    expect(result.resultPath).toBe(path.join(authorizationDir, "final-debrief.json"));
  });

  it("final debrief writer refuses path escape", async () => {
    const authorization = createAuthorization("auth-good");
    const debrief = createDebrief("../escape");

    await expect(writeCoordinationFinalDebrief(authorization, debrief)).rejects.toMatchObject({
      code: "authorization_id_mismatch",
    });
  });

  it("final debrief includes proof_attempt_id", async () => {
    const authorizationId = `auth-${Date.now()}`;
    const authorizationDir = path.join(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
    createdDirs.push(authorizationDir);
    await fs.mkdir(authorizationDir, { recursive: true });

    await writeCoordinationFinalDebrief(
      createAuthorization(authorizationId),
      createDebrief(authorizationId),
    );
    const written = JSON.parse(
      await fs.readFile(path.join(authorizationDir, "final-debrief.json"), "utf8"),
    );
    expect(written.proof_attempt_id).toBe("attempt-004");
  });

  it("final debrief includes actual_percent_complete", async () => {
    const authorizationId = `auth-${Date.now()}`;
    const authorizationDir = path.join(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
    createdDirs.push(authorizationDir);
    await fs.mkdir(authorizationDir, { recursive: true });

    await writeCoordinationFinalDebrief(
      createAuthorization(authorizationId),
      createDebrief(authorizationId),
    );
    const written = JSON.parse(
      await fs.readFile(path.join(authorizationDir, "final-debrief.json"), "utf8"),
    );
    expect(written.actual_percent_complete).toBe(88);
  });

  it("final debrief can return ready_for_live_proof", async () => {
    const authorizationId = `auth-${Date.now()}`;
    const authorizationDir = path.join(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
    createdDirs.push(authorizationDir);
    await fs.mkdir(authorizationDir, { recursive: true });

    const result = await writeCoordinationFinalDebrief(
      createAuthorization(authorizationId),
      createDebrief(authorizationId),
    );
    expect(result.status).toBe("ready_for_live_proof");
  });
});
