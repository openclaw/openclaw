import { beforeEach, describe, expect, it, vi } from "vitest";

const { withOperatorAdminGatewayClientMock, withOperatorApprovalsGatewayClientMock } = vi.hoisted(
  () => ({
    withOperatorAdminGatewayClientMock: vi.fn(),
    withOperatorApprovalsGatewayClientMock: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  withOperatorAdminGatewayClient: withOperatorAdminGatewayClientMock,
  withOperatorApprovalsGatewayClient: withOperatorApprovalsGatewayClientMock,
}));

import {
  formatPendingAgentkitApprovalsText,
  resolvePendingAgentkitApproval,
  resolveRequestedAgentkitApproval,
  type AgentkitPendingApproval,
} from "./hitl-approvals.js";

function makeApproval(id: string): AgentkitPendingApproval {
  return {
    id,
    createdAtMs: 100,
    expiresAtMs: 1_100,
    request: {
      pluginId: "agentkit",
      title: "World proof required",
      description: "Needs proof",
      severity: "warning",
      toolName: "bash",
      toolCallId: "tool-1",
      agentId: "main",
      sessionKey: "agent:main:test",
    },
  };
}

describe("agentkit pending approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects the only pending approval when no id is provided", () => {
    const approval = resolveRequestedAgentkitApproval({
      approvals: [makeApproval("plugin:1")],
    });

    expect(approval.id).toBe("plugin:1");
  });

  it("requires an explicit id when multiple approvals are pending", () => {
    expect(() =>
      resolveRequestedAgentkitApproval({
        approvals: [makeApproval("plugin:1"), makeApproval("plugin:2")],
      }),
    ).toThrow("Multiple pending AgentKit approvals");
  });

  it("formats pending approvals for operator output", () => {
    const text = formatPendingAgentkitApprovalsText([makeApproval("plugin:1")], 100);
    expect(text).toContain("Pending AgentKit approvals:");
    expect(text).toContain("plugin:1");
    expect(text).toContain("tool: bash");
  });

  it("resolves approvals through the AgentKit proof-backed gateway method", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    withOperatorAdminGatewayClientMock.mockImplementation(
      async (_opts, run) => await run({ request }),
    );

    await resolvePendingAgentkitApproval({
      appConfig: {},
      approvalId: "plugin:1",
      decision: "allow-once",
    });

    expect(withOperatorAdminGatewayClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientDisplayName: "AgentKit proof-backed approval" }),
      expect.any(Function),
    );
    expect(request).toHaveBeenCalledWith("plugin.approval.resolveVerified", {
      id: "plugin:1",
      decision: "allow-once",
      pluginId: "agentkit",
    });
  });
});
