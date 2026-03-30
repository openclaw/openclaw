import { beforeEach, describe, expect, it, vi } from "vitest";

let sendExecApprovalFollowup: typeof import("./bash-tools.exec-approval-followup.js").sendExecApprovalFollowup;
let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;

describe("sendExecApprovalFollowup", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./tools/gateway.js", () => ({
      callGatewayTool: vi.fn(),
    }));
    ({ sendExecApprovalFollowup } = await import("./bash-tools.exec-approval-followup.js"));
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(callGatewayTool).mockResolvedValue({});
  });

  it("keeps followup session-only when no external delivery target exists", async () => {
    const ok = await sendExecApprovalFollowup({
      approvalId: "approval-1",
      sessionKey: "agent:main:main",
      resultText: "Exec finished (gateway id=approval-1, code 0)",
    });

    expect(ok).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(callGatewayTool).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload.deliver).toBe(false);
    expect(payload).not.toHaveProperty("bestEffortDeliver");
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
  });

  it("keeps followup session-only when turn source is internal webchat", async () => {
    const ok = await sendExecApprovalFollowup({
      approvalId: "approval-2",
      sessionKey: "agent:main:main",
      turnSourceChannel: "webchat",
      turnSourceTo: "chat:123",
      resultText: "Exec finished (gateway id=approval-2, code 0)",
    });

    expect(ok).toBe(true);
    const payload = vi.mocked(callGatewayTool).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload.deliver).toBe(false);
    expect(payload).not.toHaveProperty("bestEffortDeliver");
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
  });

  it("enables delivery for valid external turn source targets", async () => {
    const ok = await sendExecApprovalFollowup({
      approvalId: "approval-3",
      sessionKey: "agent:main:main",
      turnSourceChannel: " discord ",
      turnSourceTo: "channel:123",
      turnSourceAccountId: "default",
      resultText: "Exec finished (gateway id=approval-3, code 0)",
    });

    expect(ok).toBe(true);
    const payload = vi.mocked(callGatewayTool).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload.deliver).toBe(true);
    expect(payload.bestEffortDeliver).toBe(true);
    expect(payload.channel).toBe("discord");
    expect(payload.to).toBe("channel:123");
    expect(payload.accountId).toBe("default");
  });
});
