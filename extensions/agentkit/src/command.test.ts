import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentkitCommand } from "./command.js";

const {
  resolveAgentkitStatusMock,
  formatAgentkitStatusTextMock,
  resolveConfiguredAgentkitPluginConfigMock,
  listPendingAgentkitApprovalsMock,
  formatPendingAgentkitApprovalsTextMock,
  resolveRequestedAgentkitApprovalMock,
  startOrReuseAgentkitHumanApprovalSessionMock,
} = vi.hoisted(() => ({
  resolveAgentkitStatusMock: vi.fn(async () => ({})),
  formatAgentkitStatusTextMock: vi.fn(() => "status-text"),
  resolveConfiguredAgentkitPluginConfigMock: vi.fn(() => ({
    hitl: {
      enabled: true,
      mode: "human-approval",
      protectedTools: ["agents_list"],
      grantScope: "session",
      grantTtlMs: 1_800_000,
    },
  })),
  listPendingAgentkitApprovalsMock: vi.fn(async () => []),
  formatPendingAgentkitApprovalsTextMock: vi.fn(() => "No pending AgentKit approvals."),
  resolveRequestedAgentkitApprovalMock: vi.fn(),
  startOrReuseAgentkitHumanApprovalSessionMock: vi.fn(),
}));

vi.mock("./status.js", () => ({
  resolveAgentkitStatus: resolveAgentkitStatusMock,
  formatAgentkitStatusText: formatAgentkitStatusTextMock,
}));

vi.mock("./config.js", () => ({
  resolveConfiguredAgentkitPluginConfig: resolveConfiguredAgentkitPluginConfigMock,
}));

vi.mock("./hitl-approvals.js", () => ({
  listPendingAgentkitApprovals: listPendingAgentkitApprovalsMock,
  formatPendingAgentkitApprovalsText: formatPendingAgentkitApprovalsTextMock,
  resolveRequestedAgentkitApproval: resolveRequestedAgentkitApprovalMock,
}));

vi.mock("./human-approval-background.js", () => ({
  startOrReuseAgentkitHumanApprovalSession: startOrReuseAgentkitHumanApprovalSessionMock,
}));

function createCommandContext(args?: string, sessionKey?: string): PluginCommandContext {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: args ? `/agentkit ${args}` : "/agentkit",
    args,
    config: {},
    sessionKey,
    sessionId: sessionKey ? `session:${sessionKey}` : undefined,
    sessionFile: sessionKey
      ? `/tmp/${sessionKey.replaceAll(/[^a-z0-9_-]/gi, "_")}.json`
      : undefined,
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

describe("agentkit runtime command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveConfiguredAgentkitPluginConfigMock.mockReturnValue({
      hitl: {
        enabled: true,
        mode: "human-approval",
        protectedTools: ["agents_list"],
        grantScope: "session",
        grantTtlMs: 1_800_000,
      },
    });
    listPendingAgentkitApprovalsMock.mockResolvedValue([]);
    formatPendingAgentkitApprovalsTextMock.mockReturnValue("No pending AgentKit approvals.");
  });

  it("lists pending approvals from a chat surface", async () => {
    const command = createAgentkitCommand(
      createTestPluginApi({
        runtime: {} as never,
      }),
    );

    const result = await command.handler(createCommandContext("approvals"));

    expect(listPendingAgentkitApprovalsMock).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("No pending AgentKit approvals.");
    expect(result.text).not.toContain("status-text");
  });

  it("starts World verification from /agentkit approve and returns a QR/link reply", async () => {
    const approval = {
      id: "plugin:approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required",
        description: "desc",
        severity: "warning" as const,
        toolName: "agents_list",
        toolCallId: "call-1",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    listPendingAgentkitApprovalsMock.mockResolvedValueOnce([approval] as never);
    resolveRequestedAgentkitApprovalMock.mockReturnValueOnce(approval as never);
    startOrReuseAgentkitHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: approval.id,
      action: "openclaw-approval-1",
      connectorURI: "https://world.org/verify?t=wld",
      decision: "allow-once",
      qrText: "██ QR",
      requestId: "request-1",
      reused: false,
    });

    const command = createAgentkitCommand(
      createTestPluginApi({
        runtime: {} as never,
      }),
    );

    const result = await command.handler(createCommandContext("approve", "agent:main:test"));

    expect(startOrReuseAgentkitHumanApprovalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approval,
        decision: "allow-once",
      }),
    );
    expect(result.text).toContain("Verify with World");
    expect(result.text).toContain("Scope: this blocked action only.");
    expect(result.text).toContain("Scan with World App:");
    expect(result.text).toContain("https://world.org/verify?t=wld");
    expect(result.text).not.toContain("AgentKit status:");
  });

  it("supports persistent human-approval decisions from the runtime command", async () => {
    const approval = {
      id: "plugin:approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required",
        description: "desc",
        severity: "warning" as const,
        toolName: "agents_list",
        toolCallId: "call-1",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    listPendingAgentkitApprovalsMock.mockResolvedValueOnce([approval] as never);
    resolveRequestedAgentkitApprovalMock.mockReturnValueOnce(approval as never);
    startOrReuseAgentkitHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: approval.id,
      action: "openclaw-approval-1",
      connectorURI: "https://world.org/verify?t=wld",
      decision: "allow-always",
      qrText: "██ QR",
      requestId: "request-1",
      reused: false,
    });

    const command = createAgentkitCommand(
      createTestPluginApi({
        runtime: {} as never,
      }),
    );

    const result = await command.handler(
      createCommandContext("approve plugin:approval-1 allow-always", "agent:main:test"),
    );

    expect(startOrReuseAgentkitHumanApprovalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approval,
        decision: "allow-always",
      }),
    );
    expect(result.text).toContain("Scope: matching protected tools in this session for 30m.");
    expect(result.text).not.toContain("AgentKit status:");
  });

  it("renders the active World session decision when a reused approval differs", async () => {
    const approval = {
      id: "plugin:approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required",
        description: "desc",
        severity: "warning" as const,
        toolName: "agents_list",
        toolCallId: "call-1",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    listPendingAgentkitApprovalsMock.mockResolvedValueOnce([approval] as never);
    resolveRequestedAgentkitApprovalMock.mockReturnValueOnce(approval as never);
    startOrReuseAgentkitHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: approval.id,
      action: "openclaw-approval-1",
      connectorURI: "https://world.org/verify?t=wld",
      decision: "allow-once",
      qrText: null,
      requestId: "request-1",
      reused: true,
    });

    const command = createAgentkitCommand(
      createTestPluginApi({
        runtime: {} as never,
      }),
    );

    const result = await command.handler(
      createCommandContext("approve plugin:approval-1 allow-always", "agent:main:test"),
    );

    expect(result.text).toContain("Verify with World is already in progress.");
    expect(result.text).toContain("Scope: this blocked action only.");
    expect(result.text).not.toContain("matching protected tools");
  });
});
