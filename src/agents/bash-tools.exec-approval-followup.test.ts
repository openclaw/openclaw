import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { callGatewayTool } from "./tools/gateway.js";

describe("sendExecApprovalFollowup", () => {
  afterEach(() => {
    vi.mocked(callGatewayTool).mockReset();
  });

  it("does not request outbound deliver for webchat-only turn source", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });

    await sendExecApprovalFollowup({
      approvalId: "a1",
      sessionKey: "agent:main:main",
      turnSourceChannel: "webchat",
      turnSourceTo: "session-1",
      resultText: "done",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        deliver: false,
        channel: undefined,
        to: undefined,
      }),
      { expectFinal: true },
    );
  });

  it("does not request outbound deliver when turn source channel is missing", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });

    await sendExecApprovalFollowup({
      approvalId: "a2",
      sessionKey: "agent:main:main",
      resultText: "done",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({ deliver: false }),
      { expectFinal: true },
    );
  });

  it("requests outbound deliver when turn source is a deliverable channel with a target", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });

    await sendExecApprovalFollowup({
      approvalId: "a3",
      sessionKey: "agent:main:main",
      turnSourceChannel: "telegram",
      turnSourceTo: "+15551234567",
      turnSourceAccountId: "default",
      turnSourceThreadId: "99",
      resultText: "done",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        deliver: true,
        channel: "telegram",
        to: "+15551234567",
        accountId: "default",
        threadId: "99",
      }),
      { expectFinal: true },
    );
  });
});
