import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCoordinationAuthorizationProofLauncher } from "./authorization-proof-launcher.js";
import { COORDINATION_WORK_AUTHORIZATION_ROOT } from "./work-authorization-contract.js";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function writeFixtureFiles() {
  const authorizationId = "auth-proof-launcher-1";
  const jobId = "job-proof-launcher-1";
  const authorizationDir = path.join(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
  const jobDir = "/Users/corey-domidocs/clawd/runtime/agent-coordination/jobs/job-proof-launcher-1";
  createdDirs.push(authorizationDir, jobDir);
  await fs.mkdir(path.join(authorizationDir, "steps"), { recursive: true });
  await fs.mkdir(jobDir, { recursive: true });

  const authorizationPath = path.join(authorizationDir, "work-authorization.json");
  const jobPath = path.join(jobDir, "job.json");

  await fs.writeFile(
    authorizationPath,
    JSON.stringify(
      {
        schema_version: "v1",
        authorization_id: authorizationId,
        objective_name: "Complete bounded loop",
        approved_by: "corey",
        approval_mode: "explicit_corey_bounded_objective_approval",
        approval_statement: "Corey approved the bounded objective.",
        created_at: "2026-04-28T18:00:00.000Z",
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
            category: "validated_coordination_command_contract",
            policy: "existing_command_contract_only",
          },
          {
            category: "safe_probe_wrapped_coordination_job",
            policy: "existing_validated_job_and_command_contract_only",
          },
        ],
        allowed_test_commands: [],
        allowed_artifact_paths: [`${authorizationDir}/**`, `${jobDir}/**`],
        allowed_agents: ["dom", "klaus"],
        allowed_job_types: ["coordination_agent_probe"],
        allowed_execution_modes: ["safe_probe_wrapped_agent_exec"],
        max_runtime_steps: 5,
        max_retries_per_step: 0,
        forbidden_surfaces: ["slack", "mcp", "zapier"],
        stop_conditions: ["proof_failed", "scope_change_required"],
        proof_requirements: { require_final_debrief: true },
        completion_definition: { final_debrief_required: true },
      },
      null,
      2,
    ),
  );

  await fs.writeFile(
    jobPath,
    JSON.stringify(
      {
        schema_version: "v1",
        id: jobId,
        created_at: "2026-04-28T18:01:00.000Z",
        approval_mode: "explicit_corey_job_approval",
        approved_by: "corey",
        approval_statement: "Corey approved this exact coordination-only watchdog job.",
        approval_scope: {
          job_id: jobId,
          agent_id: "klaus",
          job_type: "coordination_agent_probe",
          tool_policy: "coordination_only",
          timeout_seconds: 30,
          entrypoint: "/Users/corey-domidocs/src/openclaw-2026.4.21/openclaw.mjs",
          job_path: jobPath,
        },
        agent: "klaus",
        tool_policy: "coordination_only",
        execution_mode: "safe_probe_wrapped_agent_exec",
        job_type: "coordination_agent_probe",
        intent_summary: "Launcher readiness path",
        allowed_actions: [
          "validate_job_contract",
          "validate_approval",
          "run_safe_probe_wrapped_agent_exec",
          "verify_markers",
          "verify_cleanup",
          "write_watchdog_result",
        ],
        forbidden_actions: ["publish", "browser_auth", "freeform_shell", "raw_agent_exec"],
        approved_paths: {
          repo_root: "/Users/corey-domidocs/src/openclaw-2026.4.21",
          job_root: "/Users/corey-domidocs/clawd/runtime/agent-coordination/jobs",
          entrypoint: "/Users/corey-domidocs/src/openclaw-2026.4.21/openclaw.mjs",
          safe_probe:
            "/Users/corey-domidocs/src/openclaw-2026.4.21/scripts/agent-exec-safe-probe.mjs",
          node_binary: "/usr/local/bin/node",
        },
        timeout_seconds: 30,
        max_retries: 0,
        expected_markers: ["agentExecBootstrapContext_resolved"],
        forbidden_markers: ["ensureCliPluginRegistryLoaded_enter"],
        cleanup_requirements: {
          require_no_stale_lock: true,
          require_no_orphan_openclaw_children: true,
          require_no_mcp_remote: true,
          require_no_zapier_process: true,
          require_no_proof_tied_slack_runtime: true,
        },
      },
      null,
      2,
    ),
  );

  return { authorizationPath, jobPath };
}

describe("runCoordinationAuthorizationProofLauncher", () => {
  it("uses structured bridge path and reaches pre-safe-probe readiness with mocked execution", async () => {
    const { authorizationPath, jobPath } = await writeFixtureFiles();
    const runBridge = vi.fn().mockResolvedValue({
      loopResult: { status: "pass" },
      finalDebrief: { status: "ready_for_live_proof" },
      finalDebriefWrite: { wrote: true },
      watchdogRuns: [],
    });

    await runCoordinationAuthorizationProofLauncher({
      authorizationPath,
      jobPath,
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      actualPercentCompleteOnReady: 93,
      runBridge: runBridge as never,
    });

    const call = runBridge.mock.calls[0]?.[0];
    expect(call.authorization.authorization_id).toBe("auth-proof-launcher-1");
    expect(call.proofAttemptId).toBe("dom-klaus-live-proof-attempt-004");
    expect(call.steps).toHaveLength(3);
    expect(call.steps[2]).toMatchObject({
      proof_attempt_id: "dom-klaus-live-proof-attempt-004",
      kind: "watchdog",
      watchdogInput: {
        jobPath,
        useSafeProbeExecutionAdapter: true,
        persistResult: true,
      },
    });
  });

  it("does not use dist or construct raw agent-exec command strings in launcher path", async () => {
    const { authorizationPath, jobPath } = await writeFixtureFiles();
    const runBridge = vi.fn().mockResolvedValue({
      loopResult: { status: "pass" },
      finalDebrief: { status: "ready_for_live_proof" },
      finalDebriefWrite: { wrote: true },
      watchdogRuns: [],
    });

    await runCoordinationAuthorizationProofLauncher({
      authorizationPath,
      jobPath,
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      runBridge: runBridge as never,
    });

    const call = runBridge.mock.calls[0]?.[0];
    expect(JSON.stringify(call)).not.toContain("dist/openclaw.mjs");
    expect(call.steps[2]?.watchdogInput).toMatchObject({
      useSafeProbeExecutionAdapter: true,
      persistResult: true,
    });
    expect(typeof call.steps[2]?.watchdogInput).toBe("object");
    expect(
      JSON.stringify(
        call.steps.map((step: { step_name: string; command_category: string }) => ({
          step_name: step.step_name,
          command_category: step.command_category,
        })),
      ),
    ).not.toContain("agent-exec ");
  });

  it("fails closed on missing proofAttemptId", async () => {
    const { authorizationPath, jobPath } = await writeFixtureFiles();

    await expect(
      runCoordinationAuthorizationProofLauncher({
        authorizationPath,
        jobPath,
        proofAttemptId: "",
      }),
    ).rejects.toThrow(/proofAttemptId is required/);
  });

  it("is intended for repo TS runtime harness rather than direct node execution of source", async () => {
    const source = await fs.readFile(
      "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination/authorization-proof-launcher.ts",
      "utf8",
    );

    expect(source).not.toContain("process.execPath");
    expect(source).not.toContain("dist/openclaw.mjs");
    expect(source).not.toContain("agent-exec ");
    expect(source).not.toContain("child_process");
  });
});
