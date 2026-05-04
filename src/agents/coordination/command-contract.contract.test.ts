import { describe, expect, it } from "vitest";
import {
  CoordinationCommandContractValidationError,
  renderCoordinationCommand,
  validateRenderedCoordinationCommand,
} from "./command-contract.js";
import {
  COORDINATION_ALLOWED_AGENT,
  COORDINATION_ALLOWED_APPROVAL_MODE,
  COORDINATION_ALLOWED_JOB_TYPE,
  COORDINATION_ALLOWED_TOOL_POLICY,
  COORDINATION_ENTRYPOINT_PATH,
  COORDINATION_JOB_ROOT,
  COORDINATION_MAX_RETRIES,
  COORDINATION_REPO_ROOT,
  COORDINATION_REQUIRED_APPROVAL_STATEMENT,
  COORDINATION_REQUIRED_APPROVER,
  COORDINATION_REQUIRED_EXECUTION_MODE,
  COORDINATION_SAFE_PROBE_PATH,
  COORDINATION_JOB_SCHEMA_VERSION,
  validateCoordinationJobContract,
} from "./job-contract.js";

const jobPath = `${COORDINATION_JOB_ROOT}/job-456/job.json`;

function createValidatedJob() {
  return validateCoordinationJobContract(
    {
      schema_version: COORDINATION_JOB_SCHEMA_VERSION,
      id: "job-456",
      created_at: "2026-04-28T04:10:00.000Z",
      approval_mode: COORDINATION_ALLOWED_APPROVAL_MODE,
      approved_by: COORDINATION_REQUIRED_APPROVER,
      approval_statement: COORDINATION_REQUIRED_APPROVAL_STATEMENT,
      approval_scope: {
        job_id: "job-456",
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
      intent_summary: "Probe the accepted coordination-only path.",
      allowed_actions: [
        "validate_job_contract",
        "validate_approval",
        "run_safe_probe_wrapped_agent_exec",
        "verify_markers",
        "verify_cleanup",
        "write_watchdog_result",
      ],
      forbidden_actions: ["publish", "browser_auth", "freeform_shell"],
      approved_paths: {
        repo_root: COORDINATION_REPO_ROOT,
        job_root: COORDINATION_JOB_ROOT,
        entrypoint: COORDINATION_ENTRYPOINT_PATH,
        safe_probe: COORDINATION_SAFE_PROBE_PATH,
        node_binary: "/usr/local/Cellar/node/25.8.0/bin/node",
      },
      timeout_seconds: 30,
      max_retries: COORDINATION_MAX_RETRIES,
      expected_markers: ["action_handler_expected"],
      forbidden_markers: ["ensureCliPluginRegistryLoaded_enter"],
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

describe("coordination command contract", () => {
  it("valid command renders with absolute outer node binary", () => {
    const validatedJob = createValidatedJob();
    const rendered = renderCoordinationCommand(validatedJob);
    expect(rendered).toEqual({
      env: { OPENCLAW_AGENT_EXEC_DEBUG: "1" },
      cwd: COORDINATION_REPO_ROOT,
      command: "/usr/local/Cellar/node/25.8.0/bin/node",
      args: [
        "scripts/agent-exec-safe-probe.mjs",
        "--job-id",
        "job-456",
        "--out",
        `${COORDINATION_JOB_ROOT}/job-456/safe-probe-result.json`,
        "--timeout-ms",
        "30000",
        "--agent",
        "klaus",
        "--tool-policy",
        "coordination_only",
        "--",
        "/usr/local/Cellar/node/25.8.0/bin/node",
        COORDINATION_ENTRYPOINT_PATH,
        "agent-exec",
        "--agent",
        "klaus",
        "--job-id",
        "job-456",
        "--job-path",
        jobPath,
        "--timeout",
        "30",
        "--tool-policy",
        "coordination_only",
        "--json",
      ],
    });
  });

  it("requires OPENCLAW_AGENT_EXEC_DEBUG=1", () => {
    const rendered = renderCoordinationCommand(createValidatedJob()) as Record<string, unknown>;
    rendered.env = { OPENCLAW_AGENT_EXEC_DEBUG: "0" };
    expect(() => validateRenderedCoordinationCommand(rendered, createValidatedJob())).toThrowError(
      /OPENCLAW_AGENT_EXEC_DEBUG/,
    );
  });

  it("requires cwd to equal approved repo root", () => {
    const rendered = renderCoordinationCommand(createValidatedJob()) as Record<string, unknown>;
    rendered.cwd = "/tmp";
    expect(() => validateRenderedCoordinationCommand(rendered, createValidatedJob())).toThrowError(
      /cwd/,
    );
  });

  it("requires the safe-probe wrapper", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[0] = "agent-exec";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /safe-probe wrapper is required/i,
    );
  });

  it("requires the inner entrypoint to be source openclaw.mjs", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[13] = "/tmp/openclaw.mjs";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /approved source openclaw\.mjs/,
    );
  });

  it("fails if dist/openclaw.mjs appears anywhere", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[13] = `${COORDINATION_REPO_ROOT}/dist/openclaw.mjs`;
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /dist\/openclaw\.mjs/,
    );
  });

  it("fails on wrong wrapper agent", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[8] = "ashley";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Wrapper agent must be klaus/,
    );
  });

  it("fails when wrapper --out is missing", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[3] = "--timeout-ms";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Wrapper --out is required/,
    );
  });

  it("fails when wrapper --out is outside approved job directory", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[4] = "/tmp/safe-probe-result.json";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /approved job directory/,
    );
  });

  it("fails when wrapper --out filename is wrong", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[4] = `${COORDINATION_JOB_ROOT}/job-456/wrong.json`;
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /safe-probe-result\.json/,
    );
  });

  it("fails when wrapper timeout flag is missing or wrong", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[5] = "--timeout";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Wrapper --timeout-ms is required/,
    );
  });

  it("fails on wrong inner agent", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[16] = "ashley";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Inner agent must be klaus/,
    );
  });

  it("fails on wrapper and inner job id mismatch", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[18] = "job-999";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Inner job id must match/,
    );
  });

  it("fails on wrong tool policy", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[10] = "full";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Wrapper tool policy must be coordination_only/,
    );
  });

  it("command rendering fails if validated job context is missing", () => {
    const validatedJob = createValidatedJob() as unknown as { context?: { tool_policy: string } };
    delete validatedJob.context;
    expect(() => renderCoordinationCommand(validatedJob as never)).toThrowError(
      /context\.tool_policy/,
    );
  });

  it("command rendering includes wrapper --out to exact approved safe-probe-result.json path", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    expect(rendered.args[3]).toBe("--out");
    expect(rendered.args[4]).toBe(`${COORDINATION_JOB_ROOT}/job-456/safe-probe-result.json`);
  });

  it("command rendering includes wrapper --timeout-ms 30000", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    expect(rendered.args[5]).toBe("--timeout-ms");
    expect(rendered.args[6]).toBe("30000");
  });

  it("command rendering still includes wrapper --tool-policy coordination_only", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    expect(rendered.args[9]).toBe("--tool-policy");
    expect(rendered.args[10]).toBe("coordination_only");
  });

  it("command rendering includes inner --tool-policy coordination_only", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    expect(rendered.args[23]).toBe("--tool-policy");
    expect(rendered.args[24]).toBe("coordination_only");
  });

  it("command rendering still uses absolute outer and inner node binaries", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    expect(rendered.command.startsWith("/")).toBe(true);
    expect(rendered.args[12].startsWith("/")).toBe(true);
  });

  it("fails if inner --tool-policy is missing", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[23] = "--json";
    mutated.args[24] = "coordination_only";
    mutated.args[25] = "--json";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Inner --tool-policy is required/,
    );
  });

  it("fails if inner --tool-policy is wrong", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[24] = "default";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Inner tool policy must be coordination_only/,
    );
  });

  it("fails if wrapper and inner tool policy mismatch", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[10] = "default";
    mutated.args[24] = "coordination_only";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Wrapper tool policy must be coordination_only|Wrapper and inner tool policies must match/,
    );
  });

  it("fails when --json is missing", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[25] = "--verbose";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /--json is required/,
    );
  });

  it("fails on extra appended arg", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args, "--extra"] };
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Extra or missing args are forbidden/,
    );
  });

  it("fails on raw agent-exec without wrapper", () => {
    const rendered = {
      env: { OPENCLAW_AGENT_EXEC_DEBUG: "1" },
      cwd: COORDINATION_REPO_ROOT,
      command: "/usr/local/Cellar/node/25.8.0/bin/node",
      args: ["agent-exec", "--agent", "klaus"],
    };
    expect(() => validateRenderedCoordinationCommand(rendered, createValidatedJob())).toThrowError(
      CoordinationCommandContractValidationError,
    );
    expect(() => validateRenderedCoordinationCommand(rendered, createValidatedJob())).toThrowError(
      /Raw agent-exec without the safe-probe wrapper is forbidden/,
    );
  });

  it("outer bare node fails validation", () => {
    const rendered = renderCoordinationCommand(createValidatedJob()) as Record<string, unknown>;
    rendered.command = "node";
    expect(() => validateRenderedCoordinationCommand(rendered, createValidatedJob())).toThrowError(
      /absolute node binary path|approved node binary/,
    );
  });

  it("outer node mismatch fails validation", () => {
    const rendered = renderCoordinationCommand(createValidatedJob()) as Record<string, unknown>;
    rendered.command = "/usr/bin/node";
    expect(() => validateRenderedCoordinationCommand(rendered, createValidatedJob())).toThrowError(
      /approved node binary/,
    );
  });

  it("inner node mismatch fails validation", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[12] = "/usr/bin/node";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /Inner node binary must match/,
    );
  });

  it("safe-probe arg remains scripts/agent-exec-safe-probe.mjs", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    expect(rendered.args[0]).toBe("scripts/agent-exec-safe-probe.mjs");
  });

  it("cwd remains approved repo root", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    expect(rendered.cwd).toBe(COORDINATION_REPO_ROOT);
  });

  it("fails on job path outside approved root", () => {
    const rendered = renderCoordinationCommand(createValidatedJob());
    const mutated = { ...rendered, args: [...rendered.args] };
    mutated.args[20] = "/tmp/job.json";
    expect(() => validateRenderedCoordinationCommand(mutated, createValidatedJob())).toThrowError(
      /approved coordination job root/,
    );
  });
});
