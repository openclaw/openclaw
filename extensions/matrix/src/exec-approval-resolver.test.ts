import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayRuntimeHoisted = vi.hoisted(() => ({
  requestSpy: vi.fn(),
  withClientSpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  withOperatorApprovalsGatewayClient: gatewayRuntimeHoisted.withClientSpy,
}));

describe("resolveMatrixExecApproval", () => {
  beforeEach(() => {
    gatewayRuntimeHoisted.requestSpy.mockReset();
    gatewayRuntimeHoisted.withClientSpy.mockReset().mockImplementation(async (_params, run) => {
      await run({
        request: gatewayRuntimeHoisted.requestSpy,
      } as never);
    });
  });

  it("submits exec approval resolutions through the gateway approvals client", async () => {
    const { resolveMatrixExecApproval } = await import("./exec-approval-resolver.js");

    await resolveMatrixExecApproval({
      cfg: {} as never,
      approvalId: "req-123",
      decision: "allow-once",
      senderId: "@owner:example.org",
    });

    expect(gatewayRuntimeHoisted.requestSpy).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "req-123",
      decision: "allow-once",
    });
  });

  it("recognizes structured approval-not-found errors", async () => {
    const { isApprovalNotFoundError } = await import("./exec-approval-resolver.js");
    const err = new Error("approval not found");
    (err as Error & { gatewayCode?: string; details?: { reason?: string } }).gatewayCode =
      "INVALID_REQUEST";
    (err as Error & { gatewayCode?: string; details?: { reason?: string } }).details = {
      reason: "APPROVAL_NOT_FOUND",
    };

    expect(isApprovalNotFoundError(err)).toBe(true);
  });
});
