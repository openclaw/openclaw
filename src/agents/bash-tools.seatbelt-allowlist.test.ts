import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";

const {
  runExecProcessMock,
  resolveExecApprovalsMock,
  evaluateShellAllowlistMock,
  buildEnforcedShellCommandMock,
  recordAllowlistUseMock,
} = vi.hoisted(() => ({
  runExecProcessMock: vi.fn(),
  resolveExecApprovalsMock: vi.fn(),
  evaluateShellAllowlistMock: vi.fn(),
  buildEnforcedShellCommandMock: vi.fn(),
  recordAllowlistUseMock: vi.fn(),
}));

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-runtime.js")>();
  return {
    ...mod,
    runExecProcess: runExecProcessMock,
  };
});

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...mod,
    resolveExecApprovals: resolveExecApprovalsMock,
    evaluateShellAllowlist: evaluateShellAllowlistMock,
    buildEnforcedShellCommand: buildEnforcedShellCommandMock,
    recordAllowlistUse: recordAllowlistUseMock,
  };
});

const { createExecTool } = await import("./bash-tools.exec.js");

function createApprovals(security: "deny" | "allowlist" | "full" = "allowlist"): ExecApprovalsResolved {
  return {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security,
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agent: {
      security,
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    allowlist: [{ pattern: "/usr/bin/echo" }],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security,
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
}

function createRunHandle(workdir: string) {
  const startedAt = Date.now();
  return {
    session: {
      id: "sess-1",
      command: "echo ok",
      backgrounded: false,
      startedAt,
      cwd: workdir,
      tail: "",
      aggregated: "ok",
      exited: true,
      notifyOnExit: false,
      exitNotified: false,
    },
    startedAt,
    kill: () => {},
    promise: Promise.resolve({
      status: "completed" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 5,
      aggregated: "ok",
      timedOut: false,
    }),
  };
}

describe("exec seatbelt allowlist enforcement", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-exec-"));
    resolveExecApprovalsMock.mockReturnValue(createApprovals("allowlist"));
    evaluateShellAllowlistMock.mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: true,
      allowlistMatches: [{ pattern: "/usr/bin/echo" }],
      segments: [{ argv: ["echo", "ok"], resolution: { resolvedPath: "/usr/bin/echo" } }],
      segmentSatisfiedBy: [],
    });
    buildEnforcedShellCommandMock.mockReturnValue({ ok: true, command: "echo enforced" });
    runExecProcessMock.mockImplementation(async (opts: { workdir: string }) =>
      createRunHandle(opts.workdir),
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("denies seatbelt sandbox execution on allowlist miss", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: false,
      allowlistMatches: [],
      segments: [],
      segmentSatisfiedBy: [],
    });

    const tool = createExecTool({
      host: "sandbox",
      security: "allowlist",
      ask: "off",
      sandbox: {
        backend: "seatbelt",
        workspaceDir,
        containerWorkdir: "/workspace",
        seatbelt: {
          profilePath: path.join(workspaceDir, "demo-open.sb"),
          params: {},
        },
      },
    });

    await expect(tool.execute("call-deny", { command: "echo ok" })).rejects.toThrow(
      /allowlist-miss/,
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("allows seatbelt sandbox execution when allowlist/safeBins evaluation passes", async () => {
    const tool = createExecTool({
      host: "sandbox",
      security: "allowlist",
      ask: "off",
      sandbox: {
        backend: "seatbelt",
        workspaceDir,
        containerWorkdir: "/workspace",
        seatbelt: {
          profilePath: path.join(workspaceDir, "demo-open.sb"),
          params: {},
        },
      },
    });

    const result = await tool.execute("call-allow", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "echo ok",
        execCommand: "echo enforced",
      }),
    );
    expect(recordAllowlistUseMock).toHaveBeenCalled();
  });

  it("does not apply the new allowlist guardrail to docker sandbox backend yet", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: false,
      allowlistMatches: [],
      segments: [],
      segmentSatisfiedBy: [],
    });

    const tool = createExecTool({
      host: "sandbox",
      security: "allowlist",
      ask: "off",
      sandbox: {
        backend: "docker",
        workspaceDir,
        containerWorkdir: "/workspace",
        containerName: "openclaw-test-sandbox",
      },
    });

    const result = await tool.execute("call-docker", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
    expect(evaluateShellAllowlistMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).toHaveBeenCalled();
  });
});
