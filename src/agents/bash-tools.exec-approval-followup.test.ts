import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let buildExecApprovalFollowupPrompt: typeof import("./bash-tools.exec-approval-followup.js").buildExecApprovalFollowupPrompt;
let sendExecApprovalFollowup: typeof import("./bash-tools.exec-approval-followup.js").sendExecApprovalFollowup;

beforeEach(async () => {
  vi.resetModules();
  ({ callGatewayTool } = await import("./tools/gateway.js"));
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
  });

  it("uses external delivery when a deliverable route is available", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-2",
      sessionKey: "agent:main:discord:channel:123",
      turnSourceChannel: "discord",
      turnSourceTo: "123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "456",
      resultText: "Exec completed: echo ok",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        deliver: true,
        bestEffortDeliver: true,
        channel: "discord",
        to: "123",
        accountId: "default",
        threadId: "456",
      }),
      { expectFinal: true },
    );
  });
});
