import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let sendMessage: typeof import("../infra/outbound/message.js").sendMessage;
let buildExecApprovalFollowupPrompt: typeof import("./bash-tools.exec-approval-followup.js").buildExecApprovalFollowupPrompt;
let sendExecApprovalFollowup: typeof import("./bash-tools.exec-approval-followup.js").sendExecApprovalFollowup;

beforeEach(async () => {
  vi.resetModules();
  ({ callGatewayTool } = await import("./tools/gateway.js"));
  ({ sendMessage } = await import("../infra/outbound/message.js"));
  ({ buildExecApprovalFollowupPrompt, sendExecApprovalFollowup } =
    await import("./bash-tools.exec-approval-followup.js"));
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("exec approval followup", () => {
  it("uses an explicit denial prompt when the command did not run", () => {
    const prompt = buildExecApprovalFollowupPrompt(
      "Exec denied (gateway id=req-1, user-denied): uname -a",
    );

    expect(prompt).toContain("did not run");
    expect(prompt).toContain("Do not mention, summarize, or reuse output");
    expect(prompt).not.toContain("already approved has completed");
  });

  it("keeps followups internal when no external route is available", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-1",
      sessionKey: "agent:main:main",
      resultText: "Exec completed: echo ok",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliver: false,
        channel: undefined,
        to: undefined,
      }),
      { expectFinal: true },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      channel: "slack",
      sessionKey: "agent:main:slack:channel:C123",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712419200.1234",
    },
    {
      channel: "discord",
      sessionKey: "agent:main:discord:channel:123",
      to: "123",
      accountId: "default",
      threadId: "456",
    },
    {
      channel: "telegram",
      sessionKey: "agent:main:telegram:-100123",
      to: "-100123",
      accountId: "default",
      threadId: "789",
    },
  ])("uses direct external delivery for $channel followups", async (target) => {
    await sendExecApprovalFollowup({
      approvalId: `req-${target.channel}`,
      sessionKey: target.sessionKey,
      turnSourceChannel: target.channel,
      turnSourceTo: target.to,
      turnSourceAccountId: target.accountId,
      turnSourceThreadId: target.threadId,
      resultText: "slack exec approval smoke",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        content: "slack exec approval smoke",
        mirror: expect.objectContaining({
          sessionKey: target.sessionKey,
          idempotencyKey: `exec-approval-followup:req-${target.channel}`,
        }),
      }),
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("throws when neither a session nor a deliverable route is available", async () => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-missing",
        turnSourceChannel: "slack",
        resultText: "Exec completed: echo ok",
      }),
    ).rejects.toThrow("Session key or deliverable origin route is required");
  });
});
