import { describe, expect, it, vi, afterEach } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";

// Mock infrastructure dependencies
vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agents: {
        main: {
          security: "full",
          ask: "off",
          askFallback: "full",
          autoAllowSkills: false,
        },
      },
    },
  };
  return {
    ...mod,
    resolveExecApprovals: () => approvals,
    // ensure minSecurity/maxAsk are real
    minSecurity: mod.minSecurity,
    maxAsk: mod.maxAsk,
    // Mock recordAllowlistUse to avoid file writes
    recordAllowlistUse: vi.fn(),
  };
});

// Mock gateway tools to intercept approval requests
const callGatewayToolMock = vi.fn();
vi.mock("./tools/gateway.js", () => ({
  // oxlint-disable-next-line typescript/no-explicit-any
  callGatewayTool: (...args: any[]) => callGatewayToolMock(...args),
}));

// Mock process registry to avoid actual execution issues
vi.mock("./bash-process-registry.js", () => ({
  markBackgrounded: vi.fn(),
  tail: vi.fn(() => ""),
}));

// Mock runtime execution
vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-runtime.js")>();
  return {
    ...mod,
    runExecProcess: vi.fn().mockResolvedValue({
      session: { id: "mock-session", cwd: "/tmp", pid: 123 },
      startedAt: Date.now(),
      kill: vi.fn(),
      promise: Promise.resolve({
        status: "completed",
        exitCode: 0,
        durationMs: 10,
        aggregated: "mock output",
      }),
    }),
  };
});

describe("exec permission bug reproduction", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("respects user 'Always Allow' / 'Never Ask' settings even if defaults are stricter", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");

    // Create tool with NO explicit security params (uses defaults)
    // Default logic: host=gateway implied -> security=allowlist, ask=on-miss
    const tool = createExecTool({ host: "gateway" });

    // Execute a command that is NOT in the allowlist
    const result = await tool.execute("call1", {
      command: "echo 'hello world'",
      // User didn't specify security/ask in the tool call
    });

    // Expectation:
    // With bug: Tool defaults (allowlist/on-miss) override User Config (full/off).
    // Result: Approval request sent because command is not in allowlist.

    // With fix: User Config (full/off) overrides Tool Defaults.
    // Result: Runs immediately.

    // internal implementation detail: if approval is needed, it calls `exec.approval.request`
    // via callGatewayTool.
    const approvalCalls = callGatewayToolMock.mock.calls.filter(
      (args) => args[0] === "exec.approval.request",
    );

    if (approvalCalls.length > 0) {
      throw new Error("Test Failed: Approval request was sent despite 'Always Allow' setting.");
    }

    expect(approvalCalls.length).toBe(0);
    expect(result.details.status).toBe("completed");
  });
});
