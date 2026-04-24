import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/infra-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalGatewayRuntimeHoisted = vi.hoisted(() => ({
  resolveApprovalOverGatewaySpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) =>
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy(...args),
}));

describe("resolveSlackExecApproval", () => {
  async function invokeResolver(params: {
    approvalId: string;
    decision: ExecApprovalReplyDecision;
    senderId: string;
    allowPluginFallback?: boolean;
  }) {
    const { resolveSlackExecApproval } = await import("./exec-approval-resolver.js");

    await resolveSlackExecApproval({
      cfg: {} as never,
      gatewayUrl: undefined,
      ...params,
    });
  }

  function expectApprovalGatewayCall(params: {
    approvalId: string;
    decision: ExecApprovalReplyDecision;
    senderId: string;
    allowPluginFallback?: boolean;
  }) {
    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      cfg: {} as never,
      approvalId: params.approvalId,
      decision: params.decision,
      senderId: params.senderId,
      gatewayUrl: undefined,
      allowPluginFallback: params.allowPluginFallback,
      clientDisplayName: `Slack approval (${params.senderId})`,
    });
  }

  beforeEach(() => {
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("routes exec approval through resolveApprovalOverGateway", async () => {
    await invokeResolver({
      approvalId: "abc123",
      decision: "allow-once",
      senderId: "U42",
    });

    expectApprovalGatewayCall({
      approvalId: "abc123",
      decision: "allow-once",
      senderId: "U42",
    });
  });

  it("routes plugin approval ids with plugin prefix", async () => {
    await invokeResolver({
      approvalId: "plugin:xyz789",
      decision: "deny",
      senderId: "U99",
    });

    expectApprovalGatewayCall({
      approvalId: "plugin:xyz789",
      decision: "deny",
      senderId: "U99",
    });
  });

  it("passes allowPluginFallback through", async () => {
    await invokeResolver({
      approvalId: "legacy-plugin-456",
      decision: "allow-always",
      senderId: "U7",
      allowPluginFallback: true,
    });

    expectApprovalGatewayCall({
      approvalId: "legacy-plugin-456",
      decision: "allow-always",
      senderId: "U7",
      allowPluginFallback: true,
    });
  });

  it("uses Slack-specific client display name", async () => {
    await invokeResolver({
      approvalId: "test-123",
      decision: "allow-once",
      senderId: "U55",
    });

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clientDisplayName: "Slack approval (U55)",
      }),
    );
  });
});
