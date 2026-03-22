import { describe, expect, it, vi } from "vitest";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn().mockResolvedValue(undefined),
}));

import { callGatewayTool } from "./tools/gateway.js";

const baseParams = {
  approvalId: "test-approval-id",
  sessionKey: "agent:main:main",
  resultText: "Command completed successfully.",
};

describe("sendExecApprovalFollowup", () => {
  it("does not attempt external delivery in webchat-only setup (channel set, to undefined)", async () => {
    vi.mocked(callGatewayTool).mockClear();

    await sendExecApprovalFollowup({
      ...baseParams,
      turnSourceChannel: "webchat",
      turnSourceTo: undefined,
    });

    expect(callGatewayTool).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(callGatewayTool).mock.calls[0][2] as Record<string, unknown>;
    expect(callArgs.deliver).toBe(false);
    expect(callArgs.bestEffortDeliver).toBe(false);
    expect(callArgs.channel).toBeUndefined();
    expect(callArgs.to).toBeUndefined();
  });

  it("attempts external delivery when both channel and to are present", async () => {
    vi.mocked(callGatewayTool).mockClear();

    await sendExecApprovalFollowup({
      ...baseParams,
      turnSourceChannel: "telegram",
      turnSourceTo: "user:123",
      turnSourceAccountId: "account:456",
    });

    expect(callGatewayTool).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(callGatewayTool).mock.calls[0][2] as Record<string, unknown>;
    expect(callArgs.deliver).toBe(true);
    expect(callArgs.bestEffortDeliver).toBe(true);
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.to).toBe("user:123");
  });

  it("does not attempt external delivery when both channel and to are absent", async () => {
    vi.mocked(callGatewayTool).mockClear();

    await sendExecApprovalFollowup({
      ...baseParams,
      turnSourceChannel: undefined,
      turnSourceTo: undefined,
    });

    expect(callGatewayTool).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(callGatewayTool).mock.calls[0][2] as Record<string, unknown>;
    expect(callArgs.deliver).toBe(false);
    expect(callArgs.bestEffortDeliver).toBe(false);
  });

  it("returns false when sessionKey is empty", async () => {
    vi.mocked(callGatewayTool).mockClear();

    const result = await sendExecApprovalFollowup({
      ...baseParams,
      sessionKey: "",
    });

    expect(result).toBe(false);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("returns true on successful followup", async () => {
    const result = await sendExecApprovalFollowup({
      ...baseParams,
      turnSourceChannel: "webchat",
      turnSourceTo: undefined,
    });

    expect(result).toBe(true);
  });
});
