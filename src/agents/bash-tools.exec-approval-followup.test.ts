import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let sendExecApprovalFollowup: typeof import("./bash-tools.exec-approval-followup.js").sendExecApprovalFollowup;

beforeAll(async () => {
  ({ callGatewayTool } = await import("./tools/gateway.js"));
  ({ sendExecApprovalFollowup } = await import("./bash-tools.exec-approval-followup.js"));
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("sendExecApprovalFollowup", () => {
  it("keeps Web UI follow-ups in-session when no explicit target exists", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });

    const sent = await sendExecApprovalFollowup({
      approvalId: "approval-webchat",
      sessionKey: "agent:main:main",
      turnSourceChannel: "webchat",
      resultText: "Exec finished",
    });

    expect(sent).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        sessionKey: "agent:main:main",
        channel: "webchat",
        deliver: false,
        to: undefined,
        idempotencyKey: "exec-approval-followup:approval-webchat",
      }),
      { expectFinal: true },
    );
  });

  it("falls back to in-session follow-ups when the turn source is tui", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });

    const sent = await sendExecApprovalFollowup({
      approvalId: "approval-tui",
      sessionKey: "agent:main:main",
      turnSourceChannel: "tui",
      resultText: "Exec finished",
    });

    expect(sent).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        sessionKey: "agent:main:main",
        channel: undefined,
        deliver: false,
        to: undefined,
        idempotencyKey: "exec-approval-followup:approval-tui",
      }),
      { expectFinal: true },
    );
  });

  it("keeps the follow-up in-session when an external channel has no target", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });

    const sent = await sendExecApprovalFollowup({
      approvalId: "approval-telegram-missing-target",
      sessionKey: "agent:main:main",
      turnSourceChannel: "telegram",
      resultText: "Exec finished",
    });

    expect(sent).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        sessionKey: "agent:main:main",
        channel: "telegram",
        deliver: false,
        to: undefined,
        accountId: undefined,
        threadId: undefined,
        idempotencyKey: "exec-approval-followup:approval-telegram-missing-target",
      }),
      { expectFinal: true },
    );
  });

  it("preserves explicit external delivery targets when available", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });

    const sent = await sendExecApprovalFollowup({
      approvalId: "approval-whatsapp",
      sessionKey: "agent:main:main",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+15551234567",
      turnSourceAccountId: "primary",
      turnSourceThreadId: "thread-1",
      resultText: "Exec finished",
    });

    expect(sent).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        sessionKey: "agent:main:main",
        channel: "whatsapp",
        deliver: true,
        to: "+15551234567",
        accountId: "primary",
        threadId: "thread-1",
        idempotencyKey: "exec-approval-followup:approval-whatsapp",
      }),
      { expectFinal: true },
    );
  });
});
