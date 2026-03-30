import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
  };
});

vi.mock("../research/events/runtime-hooks.js", () => ({
  emitStandaloneResearchEvent: vi.fn().mockResolvedValue(undefined),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let requestExecApprovalDecision: typeof import("./bash-tools.exec-approval-request.js").requestExecApprovalDecision;
let emitStandaloneResearchEvent: typeof import("../research/events/runtime-hooks.js").emitStandaloneResearchEvent;

describe("requestExecApprovalDecision", () => {
  async function loadFreshApprovalRequestModulesForTest() {
    vi.resetModules();
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ requestExecApprovalDecision } = await import("./bash-tools.exec-approval-request.js"));
  }

  beforeAll(async () => {
    await loadFreshApprovalRequestModulesForTest();
  });

  beforeEach(async () => {
    await loadFreshApprovalRequestModulesForTest();
    ({ emitStandaloneResearchEvent } = await import("../research/events/runtime-hooks.js"));
    vi.mocked(callGatewayTool).mockClear();
    vi.mocked(emitStandaloneResearchEvent).mockClear();
  });

  it("returns string decisions", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        status: "accepted",
        id: "approval-id",
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      })
      .mockResolvedValueOnce({ decision: "allow-once" });

    const result = await requestExecApprovalDecision({
      id: "approval-id",
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      security: "allowlist",
      ask: "always",
      agentId: "main",
      resolvedPath: "/usr/bin/echo",
      sessionKey: "session",
      sessionId: "ephemeral-session-uuid",
      agentRunId: "agent-run-telemetry",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+15555550123",
      turnSourceAccountId: "work",
      turnSourceThreadId: "1739201675.123",
    });

    expect(result).toBe("allow-once");
    expect(callGatewayTool).toHaveBeenCalledWith(
      "exec.approval.request",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      {
        id: "approval-id",
        command: "echo hi",
        cwd: "/tmp",
        nodeId: undefined,
        host: "gateway",
        security: "allowlist",
        ask: "always",
        agentId: "main",
        resolvedPath: "/usr/bin/echo",
        sessionKey: "session",
        sessionId: "ephemeral-session-uuid",
        agentRunId: "agent-run-telemetry",
        turnSourceChannel: "whatsapp",
        turnSourceTo: "+15555550123",
        turnSourceAccountId: "work",
        turnSourceThreadId: "1739201675.123",
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        twoPhase: true,
      },
      { expectFinal: false },
    );
    expect(callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      {
        id: "approval-id",
        sessionKey: "session",
        agentId: "main",
        sessionId: "ephemeral-session-uuid",
      },
    );
    expect(emitStandaloneResearchEvent).toHaveBeenCalled();
    const emitCalls = vi.mocked(emitStandaloneResearchEvent).mock.calls;
    const allowCall = emitCalls.find(
      (c) => c[0]?.event && (c[0].event as { kind?: string }).kind === "approval.allow",
    );
    expect(allowCall?.[0]).toMatchObject({
      runId: "agent-run-telemetry",
      sessionId: "ephemeral-session-uuid",
      sessionKey: "session",
      agentId: "main",
    });
  });

  it("returns null for missing or non-string decisions", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ status: "accepted", id: "approval-id", expiresAtMs: 1234 })
      .mockResolvedValueOnce({});
    await expect(
      requestExecApprovalDecision({
        id: "approval-id",
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBeNull();

    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ status: "accepted", id: "approval-id-2", expiresAtMs: 1234 })
      .mockResolvedValueOnce({ decision: 123 });
    await expect(
      requestExecApprovalDecision({
        id: "approval-id-2",
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBeNull();
  });

  it("uses registration response id when waiting for decision", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        status: "accepted",
        id: "server-assigned-id",
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      })
      .mockResolvedValueOnce({ decision: "allow-once" });

    await expect(
      requestExecApprovalDecision({
        id: "client-id",
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBe("allow-once");

    expect(callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      { id: "server-assigned-id" },
    );
  });

  it("treats expired-or-missing waitDecision as null decision", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        status: "accepted",
        id: "approval-id",
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      })
      .mockRejectedValueOnce(new Error("approval expired or not found"));

    await expect(
      requestExecApprovalDecision({
        id: "approval-id",
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBeNull();
  });

  it("returns final decision directly when gateway already replies with decision", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ decision: "deny", id: "approval-id" });

    const result = await requestExecApprovalDecision({
      id: "approval-id",
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      security: "allowlist",
      ask: "on-miss",
      sessionId: "session-1",
      agentRunId: "run-1",
    });

    expect(result).toBe("deny");
    expect(vi.mocked(callGatewayTool).mock.calls).toHaveLength(1);
    const kinds = vi
      .mocked(emitStandaloneResearchEvent)
      .mock.calls.map((c) => (c[0]?.event as { kind?: string } | undefined)?.kind);
    expect(kinds).toEqual(["approval.request", "approval.deny"]);
    const denyCall = vi.mocked(emitStandaloneResearchEvent).mock.calls.find((c) => {
      const first = c[0];
      if (!first || !first.event) {
        return false;
      }
      return (first.event as { kind?: string }).kind === "approval.deny";
    });
    expect(denyCall?.[0]).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      event: {
        kind: "approval.deny",
        payload: expect.objectContaining({
          approvalId: "approval-id",
          agentRunId: "run-1",
          decision: "deny",
        }),
      },
    });
  });
});
