import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let sendExecApprovalFollowup: typeof import("./bash-tools.exec-approval-followup.js").sendExecApprovalFollowup;

describe("sendExecApprovalFollowup", () => {
  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ sendExecApprovalFollowup } = await import("./bash-tools.exec-approval-followup.js"));
  });

  beforeEach(() => {
    vi.mocked(callGatewayTool).mockClear();
    vi.mocked(callGatewayTool).mockResolvedValue(undefined);
  });

  it("sets deliver:false and omits bestEffortDeliver when no channel/to (webchat-only)", async () => {
    const result = await sendExecApprovalFollowup({
      approvalId: "a1",
      sessionKey: "sess",
      resultText: "exit 0",
    });

    expect(result).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledTimes(1);

    const payload = vi.mocked(callGatewayTool).mock.calls[0][2] as Record<string, unknown>;
    expect(payload.deliver).toBe(false);
    expect(payload).not.toHaveProperty("bestEffortDeliver");
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
  });

  it("sets deliver:true and bestEffortDeliver:true when channel and to are present", async () => {
    const result = await sendExecApprovalFollowup({
      approvalId: "a2",
      sessionKey: "sess",
      turnSourceChannel: "discord",
      turnSourceTo: "#general",
      resultText: "exit 0",
    });

    expect(result).toBe(true);

    const payload = vi.mocked(callGatewayTool).mock.calls[0][2] as Record<string, unknown>;
    expect(payload.deliver).toBe(true);
    expect(payload.bestEffortDeliver).toBe(true);
    expect(payload.channel).toBe("discord");
    expect(payload.to).toBe("#general");
  });
});
