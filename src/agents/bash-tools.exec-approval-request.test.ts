import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let requestExecApprovalDecision: typeof import("./bash-tools.exec-approval-request.js").requestExecApprovalDecision;

describe("requestExecApprovalDecision", () => {
  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ requestExecApprovalDecision } = await import("./bash-tools.exec-approval-request.js"));
  });

  beforeEach(() => {
    vi.mocked(callGatewayTool).mockClear();
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
      { id: "approval-id" },
    );
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
    });

    expect(result).toBe("deny");
    expect(vi.mocked(callGatewayTool).mock.calls).toHaveLength(1);
  });
});
