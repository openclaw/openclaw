// Telegram tests cover approval handler plugin behavior.
import type { PendingApprovalView } from "openclaw/plugin-sdk/approval-handler-runtime";
import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { buildTelegramCanonicalApprovalTerminalText } from "./approval-terminal.js";

describe("telegramApprovalNativeRuntime", () => {
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
    const payload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {
        gateway: {
          publicOrigin: "https://control.example.com",
          controlUi: { basePath: "/openclaw/" },
        },
      } as never,
      accountId: "default",
      context: { token: "tg-token" },
      request: {
        id: "system-agent:change-1",
        request: {
          title: "OpenClaw change",
          description: "set config gateway.port to 19001",
          command: "set config gateway.port to 19001",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          agentId: "main",
          sessionId: "delegation-1",
        },
        createdAtMs: 0,
        expiresAtMs: 120_000,
      },
      approvalKind: "system-agent",
      nowMs: 0,
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-1",
        phase: "pending",
        title: "OpenClaw change requires approval",
        description: "set config gateway.port to 19001",
        metadata: [{ label: "Agent", value: "main" }],
        agentId: "main",
        commandText: "set config gateway.port to 19001",
        operationSummary: "set config gateway.port to 19001",
        actions: [],
        expiresAtMs: 120_000,
      },
    });

    expect(payload.buttons?.flat().find((button) => button.url)?.url).toBe(
      "https://control.example.com/openclaw/approve/system-agent%3Achange-1",
    );
  });

  it("omits the Control UI button without a configured public origin", async () => {
    const payload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request: {
        id: "system-agent:change-2",
        request: {
          title: "OpenClaw change",
          description: "restart the Gateway",
          command: "restart the Gateway",
          proposalHash: "b".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: "delegation-2",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "system-agent",
      nowMs: 0,
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-2",
        phase: "pending",
        title: "OpenClaw change requires approval",
        metadata: [],
        commandText: "restart the Gateway",
        operationSummary: "restart the Gateway",
        actions: [],
        expiresAtMs: 60_000,
      },
    });
    expect(payload.buttons).toEqual([]);
  });

  it("omits the Control UI button when the Control UI is disabled", async () => {
    const payload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {
        gateway: {
          publicOrigin: "https://control.example.com",
          controlUi: { enabled: false },
        },
      } as never,
      accountId: "default",
      context: { token: "tg-token" },
      request: {
        id: "system-agent:change-disabled-ui",
        request: {
          title: "OpenClaw change",
          description: "restart the Gateway",
          command: "restart the Gateway",
          proposalHash: "e".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: "delegation-disabled-ui",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "system-agent",
      nowMs: 0,
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-disabled-ui",
        phase: "pending",
        title: "OpenClaw change requires approval",
        metadata: [],
        commandText: "restart the Gateway",
        operationSummary: "restart the Gateway",
        actions: [],
        expiresAtMs: 60_000,
      },
    });
    expect(payload.buttons).toEqual([]);
  });

  it("renders resolved and expired receipts without letting IDs inject lines", async () => {
    const request = {
      id: "req\n1",
      request: { command: "echo hi" },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    const resolved = await telegramApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request,
      resolved: {
        id: "req\n1",
        decision: "deny",
        resolvedBy: "telegram:9",
        ts: 1,
      },
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
    const expired = await telegramApprovalNativeRuntime.presentation.buildExpiredResult({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
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
        text: [
          "✅ Exec approval resolved",
          "Canonical result: Denied",
          "Resolved by: telegram:9",
          "ID: req\\n1",
          "",
          "Command:",
          "echo hi",
        ].join("\n"),
      },
    });
    expect(expired).toEqual({
      kind: "update",
      payload: {
        text: [
          "⏱️ Exec approval expired",
          "Canonical result: Expired",
          "ID: req\\n1",
          "",
          "Command:",
          "echo hi",
        ].join("\n"),
      },
    });
  });

  it.each([
    {
      name: "applied",
      decision: "allow-once",
      applicationStatus: "applied",
      summary: "set config gateway.port to 19001",
      expected: "✅ OpenClaw change approved and applied: set config gateway.port to 19001",
    },
    {
      name: "completion unconfirmed after an approved write",
      decision: "allow-once",
      applicationStatus: "not-applied",
      summary: "set config gateway.port to 19001",
      expected:
        "⚠️ OpenClaw change approved, but completion could not be confirmed. Check the current settings before retrying.",
    },
    {
      name: "denied and not applied",
      decision: "deny",
      applicationStatus: "not-applied",
      summary: "set config gateway.port to 19001",
      expected: "❌ OpenClaw change denied. No change was made.",
    },
    {
      name: "applied with a bounded UTF-16 summary",
      decision: "allow-once",
      applicationStatus: "applied",
      summary: ` ${"x".repeat(2798)}😀tail `,
      expected: `✅ OpenClaw change approved and applied: ${"x".repeat(2798)}…`,
    },
  ] as const)(
    "renders exact system-agent terminal receipts: $name",
    async ({ decision, applicationStatus, summary, expected }) => {
      const request = {
        approvalKind: "system-agent" as const,
        id: "system-agent:change-3",
        request: {
          title: "OpenClaw change",
          description: summary,
          command: summary,
          proposalHash: "c".repeat(64),
          allowedDecisions: ["allow-once", "deny"] as const,
          sessionId: "delegation-3",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      };
      await expect(
        telegramApprovalNativeRuntime.presentation.buildResolvedResult({
          cfg: {} as never,
          accountId: "default",
          context: { token: "tg-token" },
          request,
          resolved: {
            id: request.id,
            decision,
            ts: 1,
            applicationStatus,
          },
          view: {
            approvalKind: "system-agent",
            approvalId: request.id,
            phase: "resolved",
            title: "OpenClaw change",
            metadata: [],
            commandText: summary,
            operationSummary: summary,
            decision,
            applicationStatus,
          },
          entry: { chatId: "9", messageId: "m1" },
        }),
      ).resolves.toEqual({
        kind: "update",
        payload: {
          text: expected,
        },
      });
    },
  );

  it("updates the pending message and removes actions for terminal events", async () => {
    const editMessage = vi.fn().mockResolvedValue({
      ok: true,
      chatId: "9",
      messageId: "m1",
    });

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
        deps: { editMessage },
      },
      entry: { chatId: "9", messageId: "m1" },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
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
    const editMessage = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const request = {
      approvalKind: "system-agent" as const,
      id: "system-agent:origin-followup",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "d".repeat(64),
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "delegation-origin-followup",
        turnSourceChannel: "telegram",
        turnSourceTo: "1234",
        turnSourceThreadId: 42,
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "5678", messageId: "m1" },
      request,
      approvalKind: "system-agent",
      payload: { text: "✅ OpenClaw change approved. Applying: restart the Gateway" },
      phase: "resolved",
    });

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

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "9012", messageId: "m2" },
      request,
      approvalKind: "system-agent",
      payload: { text: "✅ OpenClaw change approved. Applying: restart the Gateway" },
      phase: "resolved",
    });
    expect(sendMessage).toHaveBeenCalledOnce();

    telegramApprovalNativeRuntime.observe?.onFinalized?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request,
      approvalKind: "system-agent",
      phase: "resolved",
    });

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "9013", messageId: "m3" },
      request,
      approvalKind: "system-agent",
      payload: { text: "✅ OpenClaw change approved. Applying: restart the Gateway" },
      phase: "resolved",
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("sends the origin result when the approver card edit fails", async () => {
    const editMessage = vi.fn().mockRejectedValue(new Error("message was deleted"));
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const request = {
      approvalKind: "system-agent" as const,
      id: "system-agent:origin-edit-failure",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "f".repeat(64),
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "delegation-origin-edit-failure",
        turnSourceChannel: "telegram",
        turnSourceTo: "1234",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };

    await expect(
      telegramApprovalNativeRuntime.transport.updateEntry?.({
        cfg: {} as never,
        accountId: "default",
        context: { token: "tg-token", deps: { editMessage, sendMessage } },
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
      {
        cfg: {},
        token: "tg-token",
        accountId: "default",
        textMode: "html",
      },
    );
  });

  it("sends origin notices only through the originating Telegram account", async () => {
    const editMessage = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const request = {
      approvalKind: "system-agent" as const,
      id: "system-agent:origin-account",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "g".repeat(64),
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "delegation-origin-account",
        turnSourceChannel: "telegram",
        turnSourceTo: "1234",
        turnSourceAccountId: "origin",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    const payload = { text: "✅ OpenClaw change approved and applied." };

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "forwarding",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "5678", messageId: "m1" },
      request,
      approvalKind: "system-agent",
      payload,
      phase: "resolved",
    });
    expect(sendMessage).not.toHaveBeenCalled();

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "origin",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "5678", messageId: "m1" },
      request,
      approvalKind: "system-agent",
      payload,
      phase: "resolved",
    });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("delivers only allowed pending actions into the originating forum topic", async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({
      chatId: "-1003841603622",
      messageId: "m1",
    });
    const request = {
      id: "req-1",
      request: { command: "echo hi" },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    const view: PendingApprovalView = {
      approvalKind: "exec",
      approvalId: "req-1",
      phase: "pending",
      title: "Exec approval",
      metadata: [],
      commandText: "echo hi",
      expiresAtMs: 60_000,
      actions: [
        {
          decision: "allow-once",
          label: "Allow Once",
          action: {
            type: "approval",
            approvalId: "req-1",
            approvalKind: "exec",
            decision: "allow-once",
          },
          command: "/approve req-1 allow-once",
          style: "success",
        },
        {
          decision: "deny",
          label: "Deny",
          action: {
            type: "approval",
            approvalId: "req-1",
            approvalKind: "exec",
            decision: "deny",
          },
          command: "/approve req-1 deny",
          style: "danger",
        },
      ],
    };
    const params = {
      cfg: {},
      accountId: "default",
      context: { token: "tg-token", deps: { sendTyping, sendMessage } },
      request,
      approvalKind: "exec" as const,
      view,
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: "telegram:-1003841603622:topic:928" },
      },
    };
    const pendingPayload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      ...params,
      nowMs: 0,
    });
    const prepared = await telegramApprovalNativeRuntime.transport.prepareTarget({
      ...params,
      pendingPayload,
    });
    if (!prepared) {
      throw new Error("Expected a forum approval target");
    }
    await telegramApprovalNativeRuntime.transport.deliverPending({
      ...params,
      pendingPayload,
      preparedTarget: prepared.target,
    });

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
    const sendTyping = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({
      chatId: "-1003841603622",
      messageId: "m1",
    });
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
      actions: [
        {
          decision: "deny",
          label: "Deny",
          style: "danger",
          command: "/approve plugin:req-1 deny",
          action: {
            type: "approval",
            approvalId: "plugin:req-1",
            approvalKind: "plugin",
            decision: "deny",
          },
        },
      ],
    };
    const params = {
      cfg: {},
      accountId: "default",
      context: { token: "tg-token", deps: { sendTyping, sendMessage } },
      request,
      approvalKind: "plugin" as const,
      view,
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: "telegram:-1003841603622:direct-topic:77" },
      },
    };
    const pendingPayload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      ...params,
      nowMs: 0,
    });
    const prepared = await telegramApprovalNativeRuntime.transport.prepareTarget({
      ...params,
      pendingPayload,
    });
    if (!prepared) {
      throw new Error("Expected a channel Direct Messages approval target");
    }
    await telegramApprovalNativeRuntime.transport.deliverPending({
      ...params,
      pendingPayload,
      preparedTarget: prepared.target,
    });

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
});
