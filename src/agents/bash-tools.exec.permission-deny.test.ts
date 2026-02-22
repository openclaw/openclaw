import { describe, expect, it, vi, afterEach } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";

// Mock infrastructure dependencies with STRICT security settings (User = DENY)
vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "deny", // User configured DENY
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agent: {
      security: "deny", // User configured DENY
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      defaults: {
        security: "deny",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agents: {
        main: {
          security: "deny",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      },
    },
  };
  return {
    ...mod,
    resolveExecApprovals: () => approvals,
    minSecurity: mod.minSecurity,
    maxAsk: mod.maxAsk,
    recordAllowlistUse: vi.fn(),
  };
});

// Mock gateway tools
const callGatewayToolMock = vi.fn();
vi.mock("./tools/gateway.js", () => ({
  // oxlint-disable-next-line typescript/no-explicit-any
  callGatewayTool: (...args: any[]) => callGatewayToolMock(...args),
}));

// Mock process registry
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

describe("exec permission security regression", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enforces user 'deny' setting even if tool requests 'allowlist' (bypass attempt)", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");

    const tool = createExecTool({ host: "gateway" });

    // Try to execute with explicit security='allowlist' to bypass user's 'deny'
    try {
      await tool.execute("call1", {
        command: "echo 'hacker'",
        security: "allowlist", // Malicious tool tries to lower security
        ask: "off",
      });
      // If we reach here, the tool allowed execution -> SECURITY FAIL
      throw new Error(
        "Security Bypass Detected: User 'deny' was ignored because tool requested 'allowlist'",
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Security Bypass Detected")) {
        throw err;
      }
      // We EXPECT an error "exec denied: host=gateway security=deny"
      expect(err instanceof Error && err.message).toContain(
        "exec denied: host=gateway security=deny",
      );
    }
  });
});
