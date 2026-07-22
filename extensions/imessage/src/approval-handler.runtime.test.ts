// Imessage tests cover approval handler plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imessageApprovalNativeRuntime } from "./approval-handler.runtime.js";

const sendMock = vi.hoisted(() => ({
  sendMessageIMessage: vi.fn(),
}));

const probeMock = vi.hoisted(() => ({
  getCachedIMessagePrivateApiStatus: vi.fn(),
  probeIMessagePrivateApi: vi.fn(),
}));

const actionsMock = vi.hoisted(() => ({
  sendPoll: vi.fn(),
  resolveChatGuidForTarget: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageIMessage: sendMock.sendMessageIMessage,
}));

vi.mock("./probe.js", () => ({
  getCachedIMessagePrivateApiStatus: probeMock.getCachedIMessagePrivateApiStatus,
  probeIMessagePrivateApi: probeMock.probeIMessagePrivateApi,
}));

vi.mock("./actions.runtime.js", () => ({
  imessageActionsRuntime: {
    sendPoll: actionsMock.sendPoll,
    resolveChatGuidForTarget: actionsMock.resolveChatGuidForTarget,
  },
}));

describe("imessageApprovalNativeRuntime", () => {
  it("renders shared reactions in pending exec approvals", async () => {
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "exec-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "exec-1",
        commandText: "echo hi",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve exec-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve exec-1 deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.text).not.toContain("3️⃣ Deny");
    expect(payload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("renders shared reactions in pending plugin approvals", async () => {
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "plugin:abc",
        request: {
          title: "Allow Codex to use 1Password?",
          description: "Allow Codex to use 1Password?",
          pluginId: "openclaw-codex-app-server",
          toolName: "codex_mcp_tool_approval",
          severity: "warning",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:abc",
        title: "Plugin approval required",
        severity: "warning",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:abc allow-once",
            style: "success",
          },
          {
            decision: "allow-always",
            label: "Allow Always",
            command: "/approve plugin:abc allow-always",
            style: "primary",
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

    expect(payload.text).toContain("Plugin approval required");
    expect(payload.text).toContain("Reply with: /approve plugin:abc allow-once|allow-always|deny");
    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("♾️ Allow Always");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("/approve <id>");
    expect(payload.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
  });

  it("normalizes iMessage handle targets and carries account ids into prepared delivery", async () => {
    await expect(
      imessageApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "ops",
        context: { accountId: "ops" },
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: {
            to: "+1 (555) 123-0000",
          },
        },
        request: {
          id: "exec-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: "exec-1",
          commandText: "echo hi",
          actions: [],
        } as never,
        pendingPayload: {
          text: "pending",
          hintlessText: "pending",
          allowedDecisions: ["allow-once"],
        },
      }),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "+15551230000",
        accountId: "ops",
      },
    });
  });

  describe("deliverPending GUID-only binding", () => {
    beforeEach(() => {
      sendMock.sendMessageIMessage.mockReset();
      // No cached bridge status: these cases exercise the text+tapback path.
      probeMock.getCachedIMessagePrivateApiStatus.mockReset();
      actionsMock.sendPoll.mockReset();
    });

    const baseDeliverArgs = {
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      preparedTarget: { to: "+15551230000", accountId: "default" },
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: "+15551230000" },
      },
      request: {
        id: "exec-1",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec" as const,
      view: {
        approvalKind: "exec",
        approvalId: "exec-1",
        commandText: "echo hi",
        actions: [],
      } as never,
      pendingPayload: {
        text: "Reply with: /approve exec-1 allow-once",
        hintlessText: "Reply with: /approve exec-1 allow-once",
        allowedDecisions: ["allow-once" as const],
      },
    };

    it("refuses to bind when the bridge returns only a numeric ROWID", async () => {
      // Regression for ClawSweeper P1: native deliverPending must require a
      // GUID for the binding because inbound `reacted_to_guid` is always a
      // GUID — never the numeric ROWID. A bridge that returns just
      // { message_id: 12345 } has no usable approval-reaction id.
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "12345",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toBeNull();
    });

    it("binds against the GUID when the bridge returns one", async () => {
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "p:0/abc-123",
        guid: "p:0/abc-123",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toEqual({
        accountId: "default",
        to: "+15551230000",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/abc-123",
      });
    });

    it("refuses to bind when the bridge returns 'unknown' or 'ok' placeholders", async () => {
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "ok",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toBeNull();
    });
  });

  it("preserves group chat targets when preparing delivery", async () => {
    await expect(
      imessageApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "default",
        context: { accountId: "default" },
        plannedTarget: {
          surface: "approver-dm",
          reason: "preferred",
          target: {
            to: "chat_guid:iMessage;+;chat42",
          },
        },
        request: {
          id: "exec-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: "exec-1",
          commandText: "echo hi",
          actions: [],
        } as never,
        pendingPayload: {
          text: "pending",
          hintlessText: "pending",
          allowedDecisions: ["allow-once"],
        },
      }),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "chat_guid:iMessage;+;chat42",
        accountId: "default",
      },
    });
  });

  it("omits the /approve fences from the poll-mode prompt", async () => {
    // The poll balloon renders every decision, so repeating them as
    // `/approve <id> ...` fences is noise. Full id stays for reconstruction.
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "exec-omit",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "exec-omit",
        commandText: "echo hi",
        actions: [
          { decision: "allow-once", label: "Allow Once", command: "/approve exec-omit allow-once" },
          { decision: "deny", label: "Deny", command: "/approve exec-omit deny" },
        ],
      } as never,
    });

    expect(payload.hintlessText).not.toContain("Other options:");
    expect(payload.hintlessText).not.toContain("/approve exec-omit deny");
    expect(payload.hintlessText).toContain("Pending command:");
    expect(payload.hintlessText).toContain("Full id:");
    // The tapback-mode text is unchanged for hosts without poll support.
    expect(payload.text).toContain("👍 Allow Once");
  });

  describe("native poll controls", () => {
    const pollDeliverArgs = {
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } } as never,
      accountId: "default",
      context: { accountId: "default" },
      preparedTarget: { to: "+15551230000", accountId: "default" },
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: "+15551230000" },
      },
      request: {
        id: "exec-poll",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec" as const,
      view: {
        approvalKind: "exec",
        approvalId: "exec-poll",
        commandText: "echo hi",
        actions: [],
        expiresAtMs: Date.now() + 60_000,
      } as never,
      pendingPayload: {
        text: "PROMPT WITH HINT\n\nReact with:\n\n👍 Allow Once",
        hintlessText: "PROMPT WITHOUT HINT",
        allowedDecisions: ["allow-once" as const, "deny" as const],
      },
    };

    beforeEach(() => {
      sendMock.sendMessageIMessage.mockReset();
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "prompt-guid",
        guid: "prompt-guid",
        sentText: "PROMPT WITHOUT HINT",
        receipt: { kind: "text" } as never,
      });
      probeMock.getCachedIMessagePrivateApiStatus.mockReset();
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        selectors: { pollPayloadMessage: true },
        rpcMethods: ["poll.send"],
      });
      probeMock.probeIMessagePrivateApi.mockReset();
      actionsMock.sendPoll.mockReset();
      actionsMock.sendPoll.mockResolvedValue({
        messageId: "poll-guid",
        pollOptions: [
          { id: "id-allow", text: "👍 Allow Once" },
          { id: "id-deny", text: "👎 Deny" },
        ],
      });
      actionsMock.resolveChatGuidForTarget.mockReset();
      actionsMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;-;+15551230000");
    });

    it("sends the hintless prompt and threads a poll under it", async () => {
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        "PROMPT WITHOUT HINT",
        expect.anything(),
      );
      expect(actionsMock.sendPoll).toHaveBeenCalledWith(
        expect.objectContaining({
          chatGuid: "iMessage;-;+15551230000",
          question: "Approve exec-pol?",
          choices: ["👍 Allow Once", "👎 Deny"],
          replyToMessageId: "prompt-guid",
        }),
      );
      expect(entry).toMatchObject({
        messageId: "prompt-guid",
        poll: { pollGuid: "poll-guid" },
      });
      expect(entry?.poll?.optionDecisions).toEqual([
        ["id-allow", "allow-once"],
        ["id-deny", "deny"],
      ]);
    });

    it("keeps the tapback hint when the bridge has no poll selector", async () => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        selectors: {},
        rpcMethods: [],
      });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("never probes the bridge on the approval path", async () => {
      // A probe spawns imsg; putting it in front of an approval prompt would
      // add seconds of latency. Cold cache degrades to tapbacks instead.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(undefined);

      await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(probeMock.probeIMessagePrivateApi).not.toHaveBeenCalled();
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    });

    it("recovers the hint when the chat turns out not to be registered with Messages", async () => {
      // Chat resolution happens after the prompt (it is an RPC and must not
      // delay approval delivery), so this degrades via the recovery path.
      actionsMock.resolveChatGuidForTarget.mockResolvedValue(null);

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        expect.stringContaining("👍 Allow Once"),
        expect.objectContaining({ replyToId: "prompt-guid" }),
      );
    });

    it("keeps the tapback hint when fewer than two decisions are allowed", async () => {
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
        pendingPayload: { ...pollDeliverArgs.pendingPayload, allowedDecisions: ["allow-once"] },
      });

      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("recovers the hint when the poll send fails after the prompt went out", async () => {
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(entry?.poll).toBeUndefined();
      // The prompt is already delivered without its hint, so the approver would
      // otherwise be left with no visible way to act.
      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        expect.stringContaining("👍 Allow Once"),
        expect.objectContaining({ replyToId: "prompt-guid" }),
      );
    });

    it("binds a reaction target to the recovery hint so tapping it resolves", async () => {
      // An unbound hint would tell the approver to react to a message no
      // tapback is bound to, which silently resolves nothing.
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));
      sendMock.sendMessageIMessage
        .mockResolvedValueOnce({
          messageId: "prompt-guid",
          guid: "prompt-guid",
          receipt: { kind: "text" } as never,
        })
        .mockResolvedValueOnce({
          messageId: "hint-guid",
          guid: "hint-guid",
          receipt: { kind: "text" } as never,
        });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(entry).toMatchObject({ messageId: "prompt-guid", hintMessageId: "hint-guid" });
    });

    it("does not bind a poll the bridge returned no GUID for", async () => {
      actionsMock.sendPoll.mockResolvedValue({ messageId: "ok", pollOptions: [] });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(entry).toMatchObject({ messageId: "prompt-guid" });
      expect(entry?.poll).toBeUndefined();
    });
  });
});
