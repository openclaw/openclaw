import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayRuntimeHoisted = vi.hoisted(() => ({
  requestSpy: vi.fn(),
  startSpy: vi.fn(),
  stopSpy: vi.fn(),
  stopAndWaitSpy: vi.fn(async () => undefined),
  createClientSpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  createOperatorApprovalsGatewayClient: gatewayRuntimeHoisted.createClientSpy,
}));

describe("resolveTelegramExecApproval", () => {
  beforeEach(() => {
    gatewayRuntimeHoisted.requestSpy.mockReset();
    gatewayRuntimeHoisted.startSpy.mockReset();
    gatewayRuntimeHoisted.stopSpy.mockReset();
    gatewayRuntimeHoisted.stopAndWaitSpy.mockReset().mockResolvedValue(undefined);
    gatewayRuntimeHoisted.createClientSpy.mockReset().mockImplementation((opts) => ({
      start: () => {
        gatewayRuntimeHoisted.startSpy();
        opts.onHelloOk?.();
      },
      request: gatewayRuntimeHoisted.requestSpy,
      stop: gatewayRuntimeHoisted.stopSpy,
      stopAndWait: gatewayRuntimeHoisted.stopAndWaitSpy,
    }));
  });

  it("routes plugin approval ids through plugin.approval.resolve", async () => {
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      cfg: {} as never,
      approvalId: "plugin:abc123",
      decision: "allow-once",
      senderId: "9",
    });

    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenCalledWith("plugin.approval.resolve", {
      id: "plugin:abc123",
      decision: "allow-once",
    });
  });

  it("falls back to plugin.approval.resolve when exec approval ids are unknown", async () => {
    gatewayRuntimeHoisted.requestSpy
      .mockRejectedValueOnce(new Error("unknown or expired approval id"))
      .mockResolvedValueOnce(undefined);
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      cfg: {} as never,
      approvalId: "legacy-plugin-123",
      decision: "allow-always",
      senderId: "9",
      allowPluginFallback: true,
    });

    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenNthCalledWith(1, "exec.approval.resolve", {
      id: "legacy-plugin-123",
      decision: "allow-always",
    });
    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenNthCalledWith(2, "plugin.approval.resolve", {
      id: "legacy-plugin-123",
      decision: "allow-always",
    });
  });

  it("falls back to plugin.approval.resolve for structured approval-not-found errors", async () => {
    const err = new Error("approval not found");
    (err as Error & { gatewayCode?: string; details?: { reason?: string } }).gatewayCode =
      "INVALID_REQUEST";
    (err as Error & { gatewayCode?: string; details?: { reason?: string } }).details = {
      reason: "APPROVAL_NOT_FOUND",
    };
    gatewayRuntimeHoisted.requestSpy.mockRejectedValueOnce(err).mockResolvedValueOnce(undefined);
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      cfg: {} as never,
      approvalId: "legacy-plugin-123",
      decision: "allow-always",
      senderId: "9",
      allowPluginFallback: true,
    });

    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenNthCalledWith(1, "exec.approval.resolve", {
      id: "legacy-plugin-123",
      decision: "allow-always",
    });
    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenNthCalledWith(2, "plugin.approval.resolve", {
      id: "legacy-plugin-123",
      decision: "allow-always",
    });
  });

  it("does not fall back to plugin.approval.resolve without explicit permission", async () => {
    gatewayRuntimeHoisted.requestSpy.mockRejectedValueOnce(
      new Error("unknown or expired approval id"),
    );
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await expect(
      resolveTelegramExecApproval({
        cfg: {} as never,
        approvalId: "legacy-plugin-123",
        decision: "allow-always",
        senderId: "9",
      }),
    ).rejects.toThrow("unknown or expired approval id");

    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenCalledTimes(1);
    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "legacy-plugin-123",
      decision: "allow-always",
    });
  });
});
