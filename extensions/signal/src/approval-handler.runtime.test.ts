import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMocks = vi.hoisted(() => ({
  sendTypingSignal: vi.fn(),
  sendMessageSignal: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendTypingSignal: sendMocks.sendTypingSignal,
  sendMessageSignal: sendMocks.sendMessageSignal,
}));

const { signalApprovalNativeRuntime } = await import("./approval-handler.runtime.js");

function buildPendingContent(params: {
  manualText: string;
  reactionText?: string;
  allowedDecisions?: readonly ("allow-once" | "allow-always" | "deny")[];
}) {
  const allowedDecisions = params.allowedDecisions ?? ["allow-once"];
  return {
    manualFallbackPayload: { text: params.manualText },
    reactionPayload: {
      text: params.reactionText ?? params.manualText,
      allowedDecisions,
      reactionBindings: [],
    },
  };
}

describe("Signal approval native runtime", () => {
  beforeEach(() => {
    sendMocks.sendTypingSignal.mockReset().mockResolvedValue(true);
    sendMocks.sendMessageSignal.mockReset().mockResolvedValue({
      messageId: "1700000000000",
      timestamp: 1700000000000,
      receipt: { parts: [] },
    });
  });

  it("honors simple plugin approval language in pending plugin approvals", async () => {
    const payload = await signalApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: { approvals: { plugin: { language: "simple" } } } as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "plugin:abc",
        request: {
          title: "Format a status message",
          description: "Only formats a short status message.",
          severity: "info",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:abc",
        title: "Format a status message",
        severity: "info",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:abc allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:abc deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.reactionPayload.text).toContain("Approval needed");
    expect(payload.reactionPayload.text).toContain("Action");
    expect(payload.reactionPayload.text).toContain("React with:");
    expect(payload.reactionPayload.text).toContain(
      "If buttons are unavailable, reply: /approve plugin:abc allow-once|deny",
    );
    expect(payload.reactionPayload.text).not.toContain("Title: Format a status message");
    expect(payload.manualFallbackPayload.text).toContain("Approval needed");
    expect(payload.manualFallbackPayload.text).not.toContain("Title: Format a status message");
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("uses the live Signal RPC context when delivering approval prompts", async () => {
    const prepared = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: { baseUrl: "http://127.0.0.1:18080", account: "+15550001111" },
    } as never);

    expect(prepared?.target).toMatchObject({
      to: "+15551230000",
      accountId: "default",
      baseUrl: "http://127.0.0.1:18080",
      account: "+15550001111",
    });

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg: {},
      preparedTarget: prepared!.target,
      pendingPayload: buildPendingContent({ manualText: "approval" }),
    } as never);

    expect(sendMocks.sendTypingSignal).toHaveBeenCalledWith("+15551230000", {
      cfg: {},
      accountId: "default",
      baseUrl: "http://127.0.0.1:18080",
      account: "+15550001111",
    });
    expect(sendMocks.sendMessageSignal).toHaveBeenCalledWith("+15551230000", "approval", {
      cfg: {},
      accountId: "default",
      baseUrl: "http://127.0.0.1:18080",
      account: "+15550001111",
      textMode: "plain",
    });
  });

  it("only renders reaction hints when the Signal target author can be bound", async () => {
    const cfg = { channels: { signal: { allowFrom: ["+15551230000"] } } };
    const unbound = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: { baseUrl: "http://127.0.0.1:18080" },
    } as never);

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg,
      preparedTarget: unbound!.target,
      pendingPayload: buildPendingContent({
        manualText:
          "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
        reactionText:
          "Exec approval required\nID: exec-1\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\nReply with: /approve exec-1 allow-once|deny",
        allowedDecisions: ["allow-once", "deny"],
      }),
    } as never);

    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      "+15551230000",
      expect.not.stringContaining("React with:"),
      expect.any(Object),
    );

    const bound = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: { baseUrl: "http://127.0.0.1:18080", account: "+15550001111" },
    } as never);

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg,
      preparedTarget: bound!.target,
      pendingPayload: buildPendingContent({
        manualText:
          "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
        reactionText:
          "Exec approval required\nID: exec-1\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\nReply with: /approve exec-1 allow-once|deny",
        allowedDecisions: ["allow-once", "deny"],
      }),
    } as never);

    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      "+15551230000",
      expect.stringContaining("React with:\n\n👍 Allow Once\n👎 Deny"),
      expect.any(Object),
    );
  });
});
