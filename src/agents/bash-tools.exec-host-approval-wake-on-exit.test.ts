import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  registerExecApprovalRequestForHostMock,
  waitForExecApprovalDecisionMock,
  emitExecSystemEventMock,
  callGatewayToolMock,
  listNodesMock,
  resolveNodeIdFromListMock,
} = vi.hoisted(() => ({
  registerExecApprovalRequestForHostMock: vi.fn(async () => ({
    expiresAtMs: Date.now() + 60_000,
    finalDecision: undefined,
  })),
  waitForExecApprovalDecisionMock: vi.fn(async () => "deny"),
  emitExecSystemEventMock: vi.fn(),
  callGatewayToolMock: vi.fn(),
  listNodesMock: vi.fn(async () => [
    { nodeId: "node-1", commands: ["system.run"], platform: "darwin" },
  ]),
  resolveNodeIdFromListMock: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(
    (params: { agentId?: string; sessionKey?: string }) => params,
  ),
  buildExecApprovalTurnSourceContext: vi.fn(
    (params: {
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    }) => params,
  ),
  registerExecApprovalRequestForHost: registerExecApprovalRequestForHostMock,
  registerExecApprovalRequestForHostOrThrow: registerExecApprovalRequestForHostMock,
  waitForExecApprovalDecision: waitForExecApprovalDecisionMock,
}));
vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_APPROVAL_TIMEOUT_MS: 120_000,
  DEFAULT_NOTIFY_TAIL_CHARS: 400,
  createApprovalSlug: vi.fn((id: string) => id.slice(0, 8)),
  emitExecSystemEvent: emitExecSystemEventMock,
  normalizeNotifyOutput: vi.fn((value: string) => value),
  runExecProcess: vi.fn(),
}));
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));
vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: listNodesMock,
  resolveNodeIdFromList: resolveNodeIdFromListMock,
}));

import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";

describe("exec host approval denied wake propagation", () => {
  beforeEach(() => {
    registerExecApprovalRequestForHostMock.mockReset();
    registerExecApprovalRequestForHostMock.mockResolvedValue({
      expiresAtMs: Date.now() + 60_000,
      finalDecision: undefined,
    });
    waitForExecApprovalDecisionMock.mockReset();
    waitForExecApprovalDecisionMock.mockResolvedValue("deny");
    emitExecSystemEventMock.mockReset();
    callGatewayToolMock.mockReset();
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([
      { nodeId: "node-1", commands: ["system.run"], platform: "darwin" },
    ]);
    resolveNodeIdFromListMock.mockReset();
    resolveNodeIdFromListMock.mockImplementation(
      (nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId,
    );
  });

  it("propagates wakeOnExit for gateway approval-denied events", async () => {
    const result = await processGatewayAllowlist({
      command: "ls -la",
      workdir: process.cwd(),
      env: {},
      pty: false,
      defaultTimeoutSec: 30,
      security: "full",
      ask: "always",
      safeBins: new Set<string>(),
      safeBinProfiles: {},
      warnings: [],
      notifySessionKey: "agent:main:main",
      wakeOnExit: true,
      approvalRunningNoticeMs: 0,
      maxOutput: 10_000,
      pendingMaxOutput: 10_000,
    });

    expect(result.pendingResult?.details?.status).toBe("approval-pending");
    await expect
      .poll(() => emitExecSystemEventMock.mock.calls.length, { timeout: 2_000, interval: 20 })
      .toBeGreaterThan(0);
    expect(emitExecSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("Exec denied (gateway"),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        wakeOnExit: true,
      }),
    );
  });

  it("propagates wakeOnExit for node approval-denied events", async () => {
    callGatewayToolMock.mockImplementation(async (method, _opts, params) => {
      if (
        method === "node.invoke" &&
        (params as { command?: string }).command === "system.run.prepare"
      ) {
        return {
          payload: {
            cmdText: "ls -la",
            plan: {
              argv: ["ls", "-la"],
              cwd: process.cwd(),
              rawCommand: "ls -la",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
          },
        };
      }
      return { ok: true };
    });

    const result = await executeNodeHostCommand({
      command: "ls -la",
      workdir: process.cwd(),
      env: {},
      security: "full",
      ask: "always",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      notifySessionKey: "agent:main:main",
      wakeOnExit: true,
    });

    expect(result.details?.status).toBe("approval-pending");
    await expect
      .poll(() => emitExecSystemEventMock.mock.calls.length, { timeout: 2_000, interval: 20 })
      .toBeGreaterThan(0);
    expect(emitExecSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("Exec denied (node="),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        wakeOnExit: true,
      }),
    );
  });
});
