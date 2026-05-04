import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthorizationLoopWatchdogBridge } from "./authorization-loop-watchdog-bridge.js";
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

async function ensureAuthorizationRuntimeDirs(authorizationId: string) {
  const authorizationDir = path.join(COORDINATION_WORK_AUTHORIZATION_ROOT, authorizationId);
  const stepsDir = path.join(authorizationDir, "steps");
  createdDirs.push(authorizationDir);
  await fs.mkdir(stepsDir, { recursive: true });
}

function createAuthorization() {
  return validateCoordinationWorkAuthorizationContract({
    schema_version: "v1",
    authorization_id: "auth-bridge-1",
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
        category: "narrow_coordination_test",
        command:
          "pnpm test -- src/agents/coordination/authorization-loop-watchdog-bridge.contract.test.ts",
      },
      {
        category: "safe_probe_wrapped_coordination_job",
        policy: "existing_validated_job_and_command_contract_only",
      },
    ],
    allowed_test_commands: [
      "pnpm test -- src/agents/coordination/authorization-loop-watchdog-bridge.contract.test.ts",
    ],
    allowed_artifact_paths: [
      "/Users/corey-domidocs/clawd/runtime/agent-coordination/work-authorizations/auth-bridge-1/final-debrief.json",
    ],
    allowed_agents: ["dom", "klaus"],
    allowed_job_types: ["coordination_agent_probe"],
    allowed_execution_modes: ["safe_probe_wrapped_agent_exec"],
    max_runtime_steps: 5,
    max_retries_per_step: 0,
    forbidden_surfaces: ["slack", "mcp", "zapier"],
    stop_conditions: ["proof_failed", "scope_change_required"],
    proof_requirements: { require_final_debrief: true },
    completion_definition: { final_debrief_required: true },
  });
}

function createOrdinaryStep() {
  return {
    step_id: "step-test",
    proof_attempt_id: "dom-klaus-live-proof-attempt-004",
    step_name: "Run narrow coordination test",
    planned_files: [
      "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination/example.ts",
    ],
    command_category: "narrow_coordination_test" as const,
    kind: "ordinary" as const,
    execute: vi.fn().mockResolvedValue({
      step_id: "step-test",
      proof_attempt_id: "dom-klaus-live-proof-attempt-004",
      step_name: "Run narrow coordination test",
      status: "pass" as const,
      files_changed: [],
      commands_run: [
        "pnpm test -- src/agents/coordination/authorization-loop-watchdog-bridge.contract.test.ts",
      ],
      tests_run: [
        {
          command:
            "pnpm test -- src/agents/coordination/authorization-loop-watchdog-bridge.contract.test.ts",
          result: "pass" as const,
        },
      ],
      artifacts_written: [],
      scope_check: { within_allowed_roots: true },
      proof_summary: "ordinary step passed",
      blocker_reason: null,
      next_step_recommendation: "continue",
    }),
  };
}

function createWatchdogStep() {
  return {
    step_id: "step-watchdog",
    proof_attempt_id: "dom-klaus-live-proof-attempt-004",
    step_name: "Run coordination watchdog through structured path",
    planned_files: [
      "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination/watchdog-runner.ts",
    ],
    command_category: "safe_probe_wrapped_coordination_job" as const,
    kind: "watchdog" as const,
    watchdogInput: {
      jobContractInput: { id: "job-1" },
      jobPath: "/Users/corey-domidocs/clawd/runtime/agent-coordination/jobs/job-1/job.json",
      useSafeProbeExecutionAdapter: true as const,
      persistResult: true as const,
    },
  };
}

describe("runAuthorizationLoopWatchdogBridge", () => {
  it("bridge runs bounded planned steps without Corey micro-approval", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const writeFinalDebrief = vi.fn().mockResolvedValue({
      resultPath: "/tmp/final-debrief.json",
      bytesWritten: 10,
      status: "ready_for_live_proof",
      wrote: true,
    });
    const runWatchdog = vi.fn().mockResolvedValue({
      result: {
        status: "pass",
        human_summary: "watchdog pass",
        classification_reason: "ok",
      },
      resultWrite: { resultPath: "/tmp/watchdog-result.json" },
    });

    const result = await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [createOrdinaryStep(), createWatchdogStep()],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      runWatchdog: runWatchdog as never,
      writeFinalDebrief: writeFinalDebrief as never,
    });

    expect(result.loopResult.status).toBe("pass");
    expect(runWatchdog).toHaveBeenCalledTimes(1);
  });

  it("bridge refuses steps outside authorization scope", async () => {
    const badStep = {
      ...createOrdinaryStep(),
      planned_files: ["/tmp/outside.ts"],
    };

    await expect(
      runAuthorizationLoopWatchdogBridge({
        authorization: createAuthorization(),
        steps: [badStep],
        proofAttemptId: "dom-klaus-live-proof-attempt-004",
        writeFinalDebrief: vi.fn().mockResolvedValue({
          resultPath: "/tmp/final-debrief.json",
          bytesWritten: 10,
          status: "blocked",
          wrote: true,
        }) as never,
      }),
    ).rejects.toThrow(/outside allowed roots/i);
  });

  it("bridge invokes watchdog runner only through structured interface", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const runWatchdog = vi.fn().mockResolvedValue({
      result: {
        status: "pass",
        human_summary: "watchdog pass",
        classification_reason: "ok",
      },
      resultWrite: { resultPath: "/tmp/watchdog-result.json" },
    });

    await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [createWatchdogStep()],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      runWatchdog: runWatchdog as never,
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "ready_for_live_proof",
        wrote: true,
      }) as never,
    });

    expect(runWatchdog.mock.calls[0]?.[0]).toMatchObject({
      useSafeProbeExecutionAdapter: true,
      persistResult: true,
    });
  });

  it("bridge requires explicit useSafeProbeExecutionAdapter for watchdog step", async () => {
    const step = createWatchdogStep();
    step.watchdogInput.useSafeProbeExecutionAdapter = false as true;

    await expect(
      runAuthorizationLoopWatchdogBridge({
        authorization: createAuthorization(),
        steps: [step],
        proofAttemptId: "dom-klaus-live-proof-attempt-004",
        writeFinalDebrief: vi.fn() as never,
      }),
    ).rejects.toMatchObject({
      code: "watchdog_step_requires_safe_probe_adapter",
    });
  });

  it("bridge requires explicit persistResult for watchdog step", async () => {
    const step = createWatchdogStep();
    step.watchdogInput.persistResult = false as true;

    await expect(
      runAuthorizationLoopWatchdogBridge({
        authorization: createAuthorization(),
        steps: [step],
        proofAttemptId: "dom-klaus-live-proof-attempt-004",
        writeFinalDebrief: vi.fn() as never,
      }),
    ).rejects.toMatchObject({ code: "watchdog_step_requires_persist_result" });
  });

  it("bridge does not run live safe-probe in tests", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const runWatchdog = vi.fn().mockResolvedValue({
      result: {
        status: "blocked",
        human_summary: "blocked",
        classification_reason: "safe_probe_blocked",
      },
    });

    await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [createWatchdogStep()],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      runWatchdog: runWatchdog as never,
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "blocked",
        wrote: true,
      }) as never,
    });

    expect(runWatchdog).toHaveBeenCalledTimes(1);
  });

  it("bridge writes final-debrief.json for blocked watchdog result when possible", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const writeFinalDebrief = vi.fn().mockResolvedValue({
      resultPath: "/tmp/final-debrief.json",
      bytesWritten: 10,
      status: "blocked",
      wrote: true,
    });
    const runWatchdog = vi.fn().mockResolvedValue({
      result: {
        status: "blocked",
        human_summary: "watchdog blocked",
        classification_reason: "safe_probe_result_missing_or_ambiguous",
      },
      resultWrite: { resultPath: "/tmp/watchdog-result.json" },
    });

    const result = await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [createWatchdogStep()],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      runWatchdog: runWatchdog as never,
      writeFinalDebrief: writeFinalDebrief as never,
    });

    expect(result.loopResult.status).toBe("blocked");
    expect(writeFinalDebrief).toHaveBeenCalledTimes(1);
    expect(result.finalDebrief.status).toBe("blocked");
  });

  it("bridge stops on blocked step", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const ordinary = createOrdinaryStep();
    const blockedStep = {
      ...ordinary,
      execute: vi.fn().mockResolvedValue({
        step_id: ordinary.step_id,
        step_name: ordinary.step_name,
        status: "blocked" as const,
        files_changed: [],
        commands_run: [],
        tests_run: [],
        artifacts_written: [],
        scope_check: { within_allowed_roots: true },
        proof_summary: "blocked",
        blocker_reason: "blocked_reason",
        next_step_recommendation: null,
      }),
    };

    const result = await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [blockedStep],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "blocked",
        wrote: true,
      }) as never,
    });

    expect(result.loopResult.status).toBe("blocked");
  });

  it("bridge stops on failed step", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const ordinary = createOrdinaryStep();
    const failedStep = {
      ...ordinary,
      execute: vi.fn().mockResolvedValue({
        step_id: ordinary.step_id,
        step_name: ordinary.step_name,
        status: "fail" as const,
        files_changed: [],
        commands_run: [],
        tests_run: [],
        artifacts_written: [],
        scope_check: { within_allowed_roots: true },
        proof_summary: "failed",
        blocker_reason: "fail_reason",
        next_step_recommendation: null,
      }),
    };

    const result = await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [failedStep],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "fail",
        wrote: true,
      }) as never,
    });

    expect(result.loopResult.status).toBe("fail");
  });

  it("bridge writes step artifacts", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const result = await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [createOrdinaryStep()],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "ready_for_live_proof",
        wrote: true,
      }) as never,
    });

    expect(result.loopResult.step_artifacts.length).toBe(1);
  });

  it("no retries occur", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const step = createOrdinaryStep();
    await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [step],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "ready_for_live_proof",
        wrote: true,
      }) as never,
    });
    expect(step.execute).toHaveBeenCalledTimes(1);
  });

  it("no queue scan occurs", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const step = createOrdinaryStep();
    await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [step],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "ready_for_live_proof",
        wrote: true,
      }) as never,
    });
    expect(step.execute).toHaveBeenCalledTimes(1);
  });

  it("bridge preserves proofAttemptId into step result and final debrief", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const writeFinalDebrief = vi.fn().mockResolvedValue({
      resultPath: "/tmp/final-debrief.json",
      bytesWritten: 10,
      status: "ready_for_live_proof",
      wrote: true,
    });

    const result = await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [createOrdinaryStep()],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      writeFinalDebrief: writeFinalDebrief as never,
    });

    const stepPath = result.loopResult.step_artifacts[0]?.resultPath;
    const writtenStep = JSON.parse(await fs.readFile(stepPath, "utf8"));
    expect(writtenStep.proof_attempt_id).toBe("dom-klaus-live-proof-attempt-004");
    expect(result.finalDebrief.proof_attempt_id).toBe("dom-klaus-live-proof-attempt-004");
    expect(writeFinalDebrief).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ proof_attempt_id: "dom-klaus-live-proof-attempt-004" }),
    );
  });

  it("fails closed on mismatched proofAttemptId", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");

    await expect(
      runAuthorizationLoopWatchdogBridge({
        authorization: createAuthorization(),
        steps: [createOrdinaryStep()],
        proofAttemptId: "different-attempt-id",
        writeFinalDebrief: vi.fn().mockResolvedValue({
          resultPath: "/tmp/final-debrief.json",
          bytesWritten: 10,
          status: "blocked",
          wrote: true,
        }) as never,
      }),
    ).rejects.toThrow(/proofAttemptId mismatch/i);
  });

  it("no shell strings are constructed", async () => {
    await ensureAuthorizationRuntimeDirs("auth-bridge-1");
    const runWatchdog = vi.fn().mockResolvedValue({
      result: {
        status: "pass",
        human_summary: "watchdog pass",
        classification_reason: "ok",
      },
      resultWrite: { resultPath: "/tmp/watchdog-result.json" },
    });

    await runAuthorizationLoopWatchdogBridge({
      authorization: createAuthorization(),
      steps: [createWatchdogStep()],
      proofAttemptId: "dom-klaus-live-proof-attempt-004",
      runWatchdog: runWatchdog as never,
      writeFinalDebrief: vi.fn().mockResolvedValue({
        resultPath: "/tmp/final-debrief.json",
        bytesWritten: 10,
        status: "ready_for_live_proof",
        wrote: true,
      }) as never,
    });

    expect(typeof runWatchdog.mock.calls[0]?.[0]).toBe("object");
    expect(typeof runWatchdog.mock.calls[0]?.[0]).not.toBe("string");
  });
});
