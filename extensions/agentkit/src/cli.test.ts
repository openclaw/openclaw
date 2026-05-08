import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentkitPendingApproval } from "./hitl-approvals.js";

const {
  filterMatchingPendingAgentkitApprovalsMock,
  formatPendingAgentkitApprovalsTextMock,
  listPendingAgentkitApprovalsMock,
  resolveConfiguredAgentkitPluginConfigMock,
  resolvePendingAgentkitApprovalMock,
  resolveRequestedAgentkitApprovalMock,
  runAgentkitWorldHumanApprovalMock,
  saveAgentkitHitlGrantMock,
} = vi.hoisted(() => ({
  filterMatchingPendingAgentkitApprovalsMock: vi.fn(),
  formatPendingAgentkitApprovalsTextMock: vi.fn(),
  listPendingAgentkitApprovalsMock: vi.fn(),
  resolveConfiguredAgentkitPluginConfigMock: vi.fn(),
  resolvePendingAgentkitApprovalMock: vi.fn(),
  resolveRequestedAgentkitApprovalMock: vi.fn(),
  runAgentkitWorldHumanApprovalMock: vi.fn(),
  saveAgentkitHitlGrantMock: vi.fn(),
}));

vi.mock("./config.js", () => ({
  resolveConfiguredAgentkitPluginConfig: resolveConfiguredAgentkitPluginConfigMock,
}));

vi.mock("./hitl-approvals.js", () => ({
  filterMatchingPendingAgentkitApprovals: filterMatchingPendingAgentkitApprovalsMock,
  formatPendingAgentkitApprovalsText: formatPendingAgentkitApprovalsTextMock,
  listPendingAgentkitApprovals: listPendingAgentkitApprovalsMock,
  resolvePendingAgentkitApproval: resolvePendingAgentkitApprovalMock,
  resolveRequestedAgentkitApproval: resolveRequestedAgentkitApprovalMock,
}));

vi.mock("./hitl-grants.js", () => ({
  saveAgentkitHitlGrant: saveAgentkitHitlGrantMock,
}));

vi.mock("./human-approval.js", () => ({
  runAgentkitWorldHumanApproval: runAgentkitWorldHumanApprovalMock,
}));

const pluginConfig = {
  hitl: {
    enabled: true,
    mode: "human-approval",
    protectedTools: ["agents_list"],
    grantScope: "session",
    grantTtlMs: 1_800_000,
    timeoutMs: 120_000,
  },
};

function createApproval(
  id: string,
  overrides: Partial<AgentkitPendingApproval["request"]> = {},
): AgentkitPendingApproval {
  return {
    id,
    createdAtMs: 1,
    expiresAtMs: 2,
    request: {
      pluginId: "agentkit",
      title: "World proof required",
      description: "desc",
      severity: "warning",
      toolName: "agents_list",
      toolCallId: id,
      agentId: "main",
      sessionKey: "agent:main:test",
      ...overrides,
    },
  };
}

describe("agentkit CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveConfiguredAgentkitPluginConfigMock.mockReturnValue(pluginConfig);
    resolvePendingAgentkitApprovalMock.mockResolvedValue(undefined);
    filterMatchingPendingAgentkitApprovalsMock.mockImplementation(
      (params: {
        approvals: AgentkitPendingApproval[];
        approval: AgentkitPendingApproval;
        pluginConfig: typeof pluginConfig;
      }) =>
        params.approvals
          .filter((candidate) => {
            if (candidate.id === params.approval.id) {
              return false;
            }
            if (candidate.request.toolName !== params.approval.request.toolName) {
              return false;
            }
            return params.pluginConfig.hitl.grantScope === "agent"
              ? params.approval.request.agentId != null &&
                  candidate.request.agentId === params.approval.request.agentId
              : params.approval.request.sessionKey != null &&
                  candidate.request.sessionKey === params.approval.request.sessionKey;
          })
          .toSorted((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
    );
    formatPendingAgentkitApprovalsTextMock.mockReturnValue("Pending AgentKit approvals:");
    runAgentkitWorldHumanApprovalMock.mockResolvedValue({
      success: true,
      action: "openclaw-approval-1",
      approvalId: "plugin:approval-1",
      connectorURI: "https://world.org/verify?t=wld",
      requestId: "request-1",
      verifyStatus: 200,
      verifyBody: { success: true },
      errorCode: null,
      nullifier: "nullifier-1",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves matching pending approvals after CLI allow-always verification", async () => {
    const approval = createApproval("plugin:approval-1");
    const sibling = createApproval("plugin:approval-2", { toolCallId: "call-2" });
    const otherTool = createApproval("plugin:approval-3", {
      toolName: "browser",
      toolCallId: "call-3",
    });
    const otherSession = createApproval("plugin:approval-4", {
      sessionKey: "agent:main:other",
      toolCallId: "call-4",
    });
    listPendingAgentkitApprovalsMock.mockResolvedValue([
      otherTool,
      sibling,
      approval,
      otherSession,
    ]);
    resolveRequestedAgentkitApprovalMock.mockReturnValue(approval);

    const { __testing } = await import("./cli.js");
    await __testing.runAgentkitApproveCommand(
      {},
      {
        approvalId: approval.id,
        decision: "allow-always",
        json: true,
      },
    );

    expect(resolvePendingAgentkitApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: approval.id,
        decision: "allow-always",
      }),
    );
    expect(resolvePendingAgentkitApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: sibling.id,
        decision: "allow-always",
      }),
    );
    expect(resolvePendingAgentkitApprovalMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: otherTool.id,
      }),
    );
    expect(resolvePendingAgentkitApprovalMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: otherSession.id,
      }),
    );
    expect(saveAgentkitHitlGrantMock).toHaveBeenCalledOnce();
  });
});
