import type { PendingApprovalView } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { SystemAgentApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { buildTelegramCanonicalApprovalTerminalText } from "./approval-terminal.js";

const { editMessage, sendMessage, sendTyping } = vi.hoisted(() => ({
  editMessage: vi.fn(),
  sendMessage: vi.fn(),
  sendTyping: vi.fn(),
}));
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageTelegram: editMessage,
  sendMessageTelegram: sendMessage,
  sendTypingTelegram: sendTyping,
  editMessageReplyMarkupTelegram: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
});

const { presentation, transport, observe } = telegramApprovalNativeRuntime;
const base = { cfg: {}, accountId: "default", context: { token: "tg-token" } };
function execRequest(id: string) {
  return { id, request: { command: "echo hi" }, createdAtMs: 0, expiresAtMs: 60_000 };
}
function systemRequest(
  id: string,
  request: Partial<SystemAgentApprovalRequest["request"]> = {},
  expiresAtMs = 60_000,
): SystemAgentApprovalRequest {
  return {
    approvalKind: "system-agent",
    id,
    createdAtMs: 0,
    expiresAtMs,
    request: {
      title: "OpenClaw change",
      description: "restart the Gateway",
      command: "restart the Gateway",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      sessionId: "delegation-fixture",
      ...request,
    },
  };
}

function pendingSystem(gateway: OpenClawConfig["gateway"]) {
  const id = "system-agent:change-1",
    summary = "set config gateway.port to 19001";
  return presentation.buildPendingPayload({
    ...base,
    cfg: { gateway },
    nowMs: 0,
    approvalKind: "system-agent",
    request: systemRequest(
      id,
      { description: summary, command: summary, agentId: "main", sessionId: "delegation-1" },
      120_000,
    ),
    view: {
      approvalKind: "system-agent",
      approvalId: id,
      phase: "pending",
      title: "OpenClaw change requires approval",
      description: summary,
      metadata: [{ label: "Agent", value: "main" }],
      agentId: "main",
      commandText: summary,
      operationSummary: summary,
      actions: [],
      expiresAtMs: 120_000,
    },
  });
}
function approvalAction(
  approvalKind: "exec" | "plugin",
  approvalId: string,
  decision: "allow-once" | "deny",
  label: string,
  style: "success" | "danger",
): PendingApprovalView["actions"][number] {
  return {
    decision,
    label,
    style,
    command: `/approve ${approvalId} ${decision}`,
    action: { type: "approval", approvalId, approvalKind, decision },
  };
}
async function deliver(
  params: Omit<Parameters<typeof transport.prepareTarget>[0], "pendingPayload">,
) {
  const pendingPayload = await presentation.buildPendingPayload({ ...params, nowMs: 0 });
  const prepared = await transport.prepareTarget({ ...params, pendingPayload });
  if (!prepared) {
    throw new Error("Expected an approval target");
  }
  await transport.deliverPending({ ...params, pendingPayload, preparedTarget: prepared.target });
}
function terminalEntry(request: SystemAgentApprovalRequest, text: string) {
  return {
    ...base,
    request,
    approvalKind: "system-agent" as const,
    phase: "resolved" as const,
    payload: { text },
  };
}

it("renders a cancelled system-agent result as lifecycle cancellation", () => {
  expect(
    buildTelegramCanonicalApprovalTerminalText({
      result: {
        applied: true,
        approval: {
          id: "system-agent:cancelled",
          status: "cancelled",
          reason: "run-aborted",
          urlPath: "/approve/system-agent:cancelled",
          createdAtMs: 0,
          expiresAtMs: 60_000,
          resolvedAtMs: 1_000,
          presentation: {
            kind: "system-agent",
            title: "OpenClaw change",
            description: "Restart the Gateway",
            proposalHash: "a".repeat(64),
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      },
      fallbackApprovalId: "system-agent:cancelled",
    }),
  ).toBe("⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry.");
});

it("builds the Control UI link with its configured base path and encoded approval ID", async () => {
  const payload = await pendingSystem({
    publicOrigin: "https://control.example.com",
    controlUi: { basePath: "/openclaw/" },
  });
  expect(payload.buttons?.flat().find((button) => button.url)?.url).toBe(
    "https://control.example.com/openclaw/approve/system-agent%3Achange-1",
  );
});

it("omits the Control UI button when the Control UI is disabled", async () => {
  const payload = await pendingSystem({
    publicOrigin: "https://control.example.com",
    controlUi: { enabled: false },
  });
  expect(payload.buttons).toEqual([]);
});

it("renders resolved and expired receipts without letting IDs inject lines", async () => {
  const request = execRequest("req\n1");
  const resolved = await presentation.buildResolvedResult({
    ...base,
    request,
    resolved: { id: "req\n1", decision: "deny", resolvedBy: "telegram:9", ts: 1 },
    view: {
      approvalKind: "exec",
      approvalId: "req\n1",
      phase: "resolved",
      title: "Exec approval",
      metadata: [],
      commandText: "echo hi",
      decision: "deny",
      resolvedBy: "telegram:9",
    } as never,
    entry: { chatId: "9", messageId: "m1" },
  });
  const expired = await presentation.buildExpiredResult({
    ...base,
    request,
    view: {
      approvalKind: "exec",
      approvalId: "req\n1",
      phase: "expired",
      title: "Exec approval",
      metadata: [],
      commandText: "echo hi",
    } as never,
    entry: { chatId: "9", messageId: "m1" },
  });

  expect(resolved).toEqual({
    kind: "update",
    payload: {
      text: "✅ Exec approval resolved\nRecorded result: Denied\nResolved by: telegram:9\nID: req\\n1\n\nCommand:\necho hi",
    },
  });
  expect(expired).toEqual({
    kind: "update",
    payload: {
      text: "⏱️ Exec approval expired\nRecorded result: Expired\nID: req\\n1\n\nCommand:\necho hi",
    },
  });
});

it("renders an applied system-agent receipt with a bounded UTF-16 summary", async () => {
  const summary = ` ${"x".repeat(2798)}😀tail `;
  const request = systemRequest("system-agent:change-3", {
    description: summary,
    command: summary,
  });
  await expect(
    presentation.buildResolvedResult({
      ...base,
      request,
      resolved: {
        id: request.id,
        decision: "allow-once",
        ts: 1,
        applicationStatus: "applied",
      },
      view: {
        approvalKind: "system-agent",
        approvalId: request.id,
        phase: "resolved",
        title: "OpenClaw change",
        metadata: [],
        commandText: summary,
        operationSummary: summary,
        decision: "allow-once",
        applicationStatus: "applied",
      },
      entry: { chatId: "9", messageId: "m1" },
    }),
  ).resolves.toEqual({
    kind: "update",
    payload: {
      text: `✅ OpenClaw change approved and applied: ${"x".repeat(2798)}…`,
    },
  });
});

it("updates the pending message and removes actions for terminal events", async () => {
  editMessage.mockResolvedValue({ ok: true, chatId: "9", messageId: "m1" });

  await transport.updateEntry?.({
    cfg: {} as never,
    accountId: "default",
    context: { token: "tg-token" },
    entry: { chatId: "9", messageId: "m1" },
    request: execRequest("approval-1"),
    approvalKind: "exec",
    payload: { text: "Canonical result: <Denied>" },
    phase: "resolved",
  });

  expect(editMessage).toHaveBeenCalledWith("9", "m1", "Canonical result: &lt;Denied&gt;", {
    cfg: {},
    token: "tg-token",
    accountId: "default",
    textMode: "html",
    buttons: [],
  });
});

it("sends one terminal origin result and releases its dedupe entry after finalization", async () => {
  editMessage.mockResolvedValue({ ok: true });
  sendMessage.mockResolvedValue({ ok: true });
  const request = systemRequest("system-agent:origin-followup", {
    turnSourceChannel: "telegram",
    turnSourceTo: "1234",
    turnSourceThreadId: 42,
  });

  const terminal = terminalEntry(
    request,
    "✅ OpenClaw change approved. Applying: restart the Gateway",
  );
  await transport.updateEntry?.({ ...terminal, entry: { chatId: "5678", messageId: "m1" } });

  expect(sendMessage).toHaveBeenCalledWith(
    "1234",
    "✅ OpenClaw change approved. Applying: restart the Gateway",
    {
      cfg: {},
      token: "tg-token",
      accountId: "default",
      textMode: "html",
      messageThreadId: 42,
    },
  );

  await transport.updateEntry?.({ ...terminal, entry: { chatId: "9012", messageId: "m2" } });
  expect(sendMessage).toHaveBeenCalledOnce();

  observe?.onFinalized?.({
    ...base,
    request,
    approvalKind: "system-agent",
    phase: "resolved",
  });

  await transport.updateEntry?.({ ...terminal, entry: { chatId: "9013", messageId: "m3" } });
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

it("sends the origin result when the approver card edit fails", async () => {
  editMessage.mockRejectedValue(new Error("message was deleted"));
  sendMessage.mockResolvedValue({ ok: true });
  const request = systemRequest("system-agent:origin-edit-failure", {
    turnSourceChannel: "telegram",
    turnSourceTo: "1234",
  });

  await expect(
    transport.updateEntry?.({
      ...base,
      entry: { chatId: "5678", messageId: "m1" },
      request,
      approvalKind: "system-agent",
      payload: { text: "⚠️ OpenClaw change approved, but it was not applied." },
      phase: "resolved",
    }),
  ).rejects.toThrow("message was deleted");
  expect(sendMessage).toHaveBeenCalledWith(
    "1234",
    "⚠️ OpenClaw change approved, but it was not applied.",
    { cfg: {}, token: "tg-token", accountId: "default", textMode: "html" },
  );
});

it("sends origin notices only through the originating Telegram account", async () => {
  editMessage.mockResolvedValue({ ok: true });
  sendMessage.mockResolvedValue({ ok: true });
  const request = systemRequest("system-agent:origin-account", {
    turnSourceChannel: "telegram",
    turnSourceTo: "1234",
    turnSourceAccountId: "origin",
  });
  const terminal = {
    ...terminalEntry(request, "✅ OpenClaw change approved and applied."),
    entry: { chatId: "5678", messageId: "m1" },
  };

  await transport.updateEntry?.({ ...terminal, accountId: "forwarding" });
  expect(sendMessage).not.toHaveBeenCalled();

  await transport.updateEntry?.({ ...terminal, accountId: "origin" });
  expect(sendMessage).toHaveBeenCalledOnce();
});

it("delivers only allowed pending actions into the originating forum topic", async () => {
  sendTyping.mockResolvedValue({ ok: true });
  sendMessage.mockResolvedValue({ chatId: "-1003841603622", messageId: "m1" });
  const request = execRequest("req-1");
  const view: PendingApprovalView = {
    approvalKind: "exec",
    approvalId: "req-1",
    phase: "pending",
    title: "Exec approval",
    metadata: [],
    commandText: "echo hi",
    expiresAtMs: 60_000,
    actions: [
      approvalAction("exec", "req-1", "allow-once", "Allow Once", "success"),
      approvalAction("exec", "req-1", "deny", "Deny", "danger"),
    ],
  };
  const params = {
    ...base,
    request,
    approvalKind: "exec" as const,
    view,
    plannedTarget: {
      surface: "origin" as const,
      reason: "preferred" as const,
      target: { to: "telegram:-1003841603622:topic:928" },
    },
  };
  await deliver(params);

  expect(sendTyping).toHaveBeenCalledWith(
    "-1003841603622",
    expect.objectContaining({ messageThreadId: 928 }),
  );
  expect(sendMessage).toHaveBeenCalledWith(
    "-1003841603622",
    expect.stringContaining("/approve req-1 allow-once"),
    expect.objectContaining({
      messageThreadId: 928,
      buttons: [
        [
          expect.objectContaining({ text: "Allow Once", callback_data: "tga1:e:o:req-1" }),
          expect.objectContaining({ text: "Deny", callback_data: "tga1:e:d:req-1" }),
        ],
      ],
    }),
  );
  expect(sendMessage.mock.calls[0]?.[1]).not.toContain("allow-always");
  expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("directMessagesTopicId");
});

it("delivers plugin scope and actions using channel Direct Messages topic metadata", async () => {
  sendTyping.mockResolvedValue({ ok: true });
  sendMessage.mockResolvedValue({ chatId: "-1003841603622", messageId: "m1" });
  const scope = {
    kind: "message-send" as const,
    target: "email",
    recipientCount: 3,
    recipients: ["alice@example.com"],
    audience: "external" as const,
  };
  const request = {
    approvalKind: "plugin" as const,
    id: "plugin:req-1",
    request: {
      title: "Send email",
      description: "Deliver the requested announcement.",
      scope,
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
  const view: PendingApprovalView = {
    approvalKind: "plugin",
    phase: "pending",
    approvalId: "plugin:req-1",
    title: "Send email",
    description: "Deliver the requested announcement.",
    severity: "warning",
    scope,
    metadata: [],
    expiresAtMs: 60_000,
    actions: [approvalAction("plugin", "plugin:req-1", "deny", "Deny", "danger")],
  };
  const params = {
    ...base,
    request,
    approvalKind: "plugin" as const,
    view,
    plannedTarget: {
      surface: "origin" as const,
      reason: "preferred" as const,
      target: { to: "telegram:-1003841603622:direct-topic:77" },
    },
  };
  await deliver(params);

  expect(sendMessage).toHaveBeenCalledWith(
    "-1003841603622",
    expect.stringContaining("3 recipients via email"),
    expect.objectContaining({
      directMessagesTopicId: 77,
      buttons: [[expect.objectContaining({ callback_data: "tga1:p:d:plugin:req-1" })]],
    }),
  );
  expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("messageThreadId");
  expect(sendMessage.mock.calls[0]?.[1]).toContain("alice@example.com");
});
