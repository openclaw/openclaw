// Signal tests cover approval handler plugin behavior.
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

function buildExecRequest() {
  return {
    id: "exec-1",
    request: {
      command: "echo hi",
      agentId: "main",
      turnSourceChannel: "signal",
      turnSourceTo: "+15551230000",
      turnSourceAccountId: "default",
      sessionKey: "agent:main:signal:+15551230000",
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
}

function buildPluginRequest() {
  return {
    id: "plugin:approval-1",
    request: {
      title: "Plugin approval",
      description: "Allow plugin action",
      agentId: "main",
      turnSourceChannel: "signal",
      turnSourceTo: "+15551230000",
      turnSourceAccountId: "default",
      sessionKey: "agent:main:signal:+15551230000",
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
}

function buildExecView() {
  return {
    approvalId: "exec-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [],
    ask: "always",
    agentId: "main",
    commandText: "echo hi",
    cwd: "/tmp/work",
    host: "gateway",
    sessionKey: "agent:main:signal:+15551230000",
    actions: [
      {
        kind: "decision",
        decision: "allow-once",
        label: "Allow Once",
        style: "primary",
        command: "/approve exec-1 allow-once",
      },
      {
        kind: "decision",
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve exec-1 deny",
      },
    ],
    expiresAtMs: 60_000,
  };
}

function buildPluginView() {
  return {
    approvalId: "plugin:approval-1",
    approvalKind: "plugin",
    phase: "pending",
    title: "Plugin approval",
    description: "Allow plugin action",
    metadata: [],
    agentId: "main",
    severity: "warning",
    actions: [
      {
        kind: "decision",
        decision: "allow-once",
        label: "Allow Once",
        style: "primary",
        command: "/approve plugin:approval-1 allow-once",
      },
      {
        kind: "decision",
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve plugin:approval-1 deny",
      },
    ],
    expiresAtMs: 60_000,
  };
}

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

  it("delivers runtime-built exec approval prompts with canonical reaction bindings", async () => {
    const prepared = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: {
        baseUrl: "http://127.0.0.1:18080",
        account: "+15550001111",
        accountUuid: "abcdef12-3456-7890-abcd-ef1234567890",
      },
    } as never);
    const request = buildExecRequest();
    const pendingPayload = await signalApprovalNativeRuntime.presentation.buildPendingPayload({
      request,
      nowMs: 0,
      view: buildExecView(),
    } as never);

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg: { channels: { signal: { allowFrom: ["+15551230000"] } } },
      preparedTarget: prepared!.target,
      pendingPayload,
    } as never);

    const deliveredText = sendMocks.sendMessageSignal.mock.calls.at(-1)?.[1] as string;
    expect(deliveredText).toContain("ID: exec-1");
    expect(deliveredText).toContain("/approve exec-1 allow-once");
    expect(deliveredText).toContain("React with:\n\n👍 Allow Once");
    expect(deliveredText).not.toContain("<id>");
  });

  it("delivers runtime-built plugin approval prompts with canonical reaction bindings", async () => {
    const prepared = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: {
        baseUrl: "http://127.0.0.1:18080",
        account: "+15550001111",
        accountUuid: "abcdef12-3456-7890-abcd-ef1234567890",
      },
    } as never);
    const request = buildPluginRequest();
    const pendingPayload = await signalApprovalNativeRuntime.presentation.buildPendingPayload({
      request,
      nowMs: 0,
      view: buildPluginView(),
    } as never);

    await signalApprovalNativeRuntime.transport.deliverPending({
      cfg: { channels: { signal: { allowFrom: ["+15551230000"] } } },
      preparedTarget: prepared!.target,
      pendingPayload,
    } as never);

    const deliveredText = sendMocks.sendMessageSignal.mock.calls.at(-1)?.[1] as string;
    expect(deliveredText).toContain("ID: plugin:approval-1");
    expect(deliveredText).toContain("/approve plugin:approval-1 allow-once");
    expect(deliveredText).toContain("React with:\n\n👍 Allow Once");
    expect(deliveredText).not.toContain("<id>");
  });
});
