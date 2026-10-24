import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  getSlackInteractionMocks,
  registerSlackInteractionEvents,
  setupInteractions as setupRegisteredInteractions,
} from "./interactions.test-runtime.js";
import {
  actionBody,
  approvalButtonBlocks,
  approvalContextOptions,
  approvedPluginBindingResult,
  button,
  createContext,
  plainText,
  singleButtonBlocks,
} from "./interactions.test-support.js";

const {
  enqueueSessionEventMock,
  captureSessionEventTargetMock,
  ack,
  respond,
  readSlackMessagesMock,
  dispatchPluginInteractiveHandlerMock,
  resolvePluginConversationBindingApprovalMock,
  resolveApprovalOverGatewayMock,
  resolveQuestionOverGatewayMock,
} = getSlackInteractionMocks();

const requireRecord = createRequireRecord("object", "expected-label-capitalized");

function expectRecordFields(actual: object, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(requireRecord(actual, "actual")[key]).toEqual(value);
  }
}

function pluginDispatchCall(index = 0) {
  return expectDefined(
    dispatchPluginInteractiveHandlerMock.mock.calls[index]?.[0],
    "plugin dispatch",
  );
}
function slackInteractionPayload(callIndex = 0): Record<string, unknown> {
  return JSON.parse(enqueueSystemEventText(callIndex).replace("Slack interaction: ", ""));
}
function eventOptions() {
  return expectDefined(enqueueSessionEventMock.mock.calls[0]?.[1], "event options");
}
function enqueueSystemEventText(callIndex = 0) {
  return expectDefined(enqueueSessionEventMock.mock.calls[callIndex]?.[0], "event text");
}
function chatUpdateCall(app: ReturnType<typeof createContext>["app"]) {
  return requireRecord(app.client.chat.update.mock.calls[0]?.[0], "chat.update");
}

function expectUpdated(
  app: Parameters<typeof chatUpdateCall>[0],
  expected: Record<string, unknown>,
) {
  expectRecordFields(chatUpdateCall(app), { channel: "C1", ts: "100.200", ...expected });
}

function inputByActionId(
  inputs: Array<Record<string, unknown>>,
  actionId: string,
): Record<string, unknown> {
  const input = inputs.find((entry) => entry.actionId === actionId);
  if (!input) {
    throw new Error(`Expected input ${actionId}`);
  }
  return input;
}

function option(label: string, value: string) {
  return { text: plainText(label), value };
}
function viewState(inputs: Record<string, Record<string, unknown>>) {
  return {
    values: Object.fromEntries(Object.entries(inputs).map(([id, input]) => [id, { [id]: input }])),
  };
}
function control(actionId: string) {
  return { type: "button", action_id: actionId };
}
function buttonMessage(blockId: string, actionId: string, text = "fallback") {
  return { text, blocks: singleButtonBlocks(blockId, actionId) };
}
function viewBody(
  view: NonNullable<
    Parameters<ReturnType<ReturnType<typeof createContext>["getViewHandler"]>>[0]["body"]["view"]
  >,
  userId: string,
  extra: Omit<
    Parameters<ReturnType<ReturnType<typeof createContext>["getViewHandler"]>>[0]["body"],
    "view" | "user"
  > = {},
) {
  return { user: { id: userId }, view, ...extra };
}
function modalBody(
  userId: string,
  metadata: Record<string, unknown>,
  view: Parameters<typeof viewBody>[0] = {},
  extra: Parameters<typeof viewBody>[2] = {},
) {
  return viewBody(
    {
      callback_id: "openclaw:deploy_form",
      private_metadata: JSON.stringify({ userId, ...metadata }),
      ...view,
    },
    userId,
    extra,
  );
}
function approvalButton(value: string, blockId = "exec_actions", label = "Allow once") {
  return button("openclaw:approval_button:1:1", blockId, value, label);
}
function expectPrivateReply(text: string) {
  expect(respond).toHaveBeenCalledWith({ text, response_type: "ephemeral" });
}
function expectApproval(cfg: unknown, overrides: Record<string, unknown> = {}) {
  expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
    cfg,
    approvalId: "req-123",
    approvalKind: "exec",
    decision: "allow-once",
    senderId: "U123",
    channel: "slack",
    accountId: "default",
    ...overrides,
  });
}
function expectSessionEvent(agentId: string, sessionKey: string) {
  expect(eventOptions()).toMatchObject({ agentId, sessionKey, createIfMissing: true });
  expect(captureSessionEventTargetMock).toHaveBeenCalledWith(agentId, sessionKey);
}
const pluginHandled = { matched: true, handled: true, duplicate: false };
function actions(blockId: string, elements: Record<string, unknown>[]) {
  return { type: "actions", block_id: blockId, elements };
}
function section(text: string, blockId?: string) {
  return {
    type: "section",
    ...(blockId ? { block_id: blockId } : {}),
    text: { type: "mrkdwn", text },
  };
}
function richText(...texts: string[]) {
  return {
    type: "rich_text",
    elements: [
      { type: "rich_text_section", elements: texts.map((text) => ({ type: "text", text })) },
    ],
  };
}
function currentMessage(blocks: unknown[]) {
  readSlackMessagesMock.mockResolvedValueOnce({
    messages: [{ ts: "100.200", blocks }],
    hasMore: false,
  });
}
function shortcutBody() {
  return {
    type: "shortcut" as const,
    callback_id: "capture-note",
    trigger_id: "123.trigger",
    user: { id: "U123", username: "ada", team_id: "T9" },
    team: { id: "T9", domain: "example" },
    token: "secret",
    action_ts: "100.200",
  };
}
function confirmation(text: string) {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function setupInteractions(options?: Parameters<typeof createContext>[0]) {
  return withActions(setupRegisteredInteractions(options));
}

type ActionArgs = Parameters<ReturnType<ReturnType<typeof createContext>["getHandler"]>>[0];
function interactionContext(options?: Parameters<typeof createContext>[0]) {
  return withActions(createContext(options));
}
function withActions(context: ReturnType<typeof createContext>) {
  return {
    ...context,
    click: (
      action: ActionArgs["action"],
      message: Parameters<typeof actionBody>[0] = {},
      body: Parameters<typeof actionBody>[1] = {},
      extra: Omit<ActionArgs, "ack" | "body" | "action"> = {},
    ) => context.getHandler()({ ack, body: actionBody(message, body), action, ...extra }),
    act: (
      body: ActionArgs["body"],
      action: ActionArgs["action"],
      extra: Omit<ActionArgs, "ack" | "body" | "action"> = {},
    ) => context.getHandler()({ ack, body, action, ...extra }),
  };
}

function mpimPolicy() {
  return {
    allowFrom: ["U_OWNER"],
    resolveChannelName: async () => ({ name: "group-dm", type: "mpim" as const }),
  };
}

function execApprovalOptions() {
  return {
    allowFrom: ["U999"],
    cfg: {
      channels: {
        slack: { execApprovals: { enabled: true, approvers: ["u123"], target: "both" } },
      },
    },
  };
}

function interactionInputs(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.inputs)) {
    throw new Error("Expected interaction inputs");
  }
  return payload.inputs.map((input) => requireRecord(input, "interaction input"));
}

describe("registerSlackInteractionEvents", () => {
  it.each([false, true])("routes shortcuts (selected message: %s)", async (message) => {
    const { ctx, getShortcutHandler, resolveSessionKey } = interactionContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
      resolveChannelName: async () => ({ name: "ops", type: "channel" }),
    });
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });
    const common = shortcutBody();
    await getShortcutHandler()({
      ack,
      context: { teamId: "T9" },
      body: message
        ? {
            ...common,
            type: "message_action",
            channel: { id: "C1", name: "ops" },
            message_ts: "200.300",
            response_url: "https://hooks.slack.test/response",
            message: {
              type: "message",
              user: "U456",
              ts: "200.300",
              text: "Selected message",
              thread_ts: "200.100",
            },
          }
        : common,
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledOnce();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: message ? "C1" : undefined,
      channelType: message ? "channel" : "im",
      senderId: "U123",
      threadTs: message ? "200.100" : undefined,
      eventScope: expect.objectContaining({ teamId: "T9" }),
    });
    expect(slackInteractionPayload()).toMatchObject({
      interactionType: message ? "message_shortcut" : "global_shortcut",
      actionId: "shortcut:capture-note",
      callbackId: "capture-note",
      userId: "U123",
      teamId: "T9",
      triggerId: "[redacted]",
      actionTs: "100.200",
      ...(message
        ? {
            channelId: "C1",
            channelName: "ops",
            messageTs: "200.300",
            threadTs: "200.100",
            messageUserId: "U456",
            messageText: "Selected message",
            responseUrl: "[redacted]",
          }
        : {}),
    });
    expect(enqueueSystemEventText()).not.toContain("secret");
    expect(eventOptions()).toMatchObject({
      sessionKey: "agent:ops:slack:channel:C1",
      deliveryContext: {
        channel: "slack",
        accountId: "default",
        to: message ? "team:T9:channel:C1" : "team:T9:user:U123",
        ...(message ? { threadId: "200.100" } : {}),
      },
    });
  });

  it("acknowledges mismatched shortcuts before dropping them", async () => {
    const order: string[] = [];
    const { getShortcutHandler } = setupInteractions({
      shouldDropMismatchedSlackEvent: () => {
        order.push("filter");
        return true;
      },
    });

    await getShortcutHandler()({
      ack: vi.fn(async () => {
        order.push("ack");
      }),
      body: shortcutBody(),
    });

    expect(order).toEqual(["ack", "filter"]);
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("enforces DM policy for global shortcuts", async () => {
    const { getShortcutHandler } = setupInteractions({ dmEnabled: false, dmPolicy: "disabled" });

    await getShortcutHandler()({ ack, body: shortcutBody() });

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("enqueues structured events and updates button rows", async () => {
    const { app, click, resolveSessionKey } = setupInteractions({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
    });
    const neighbor = actions("deploy_row", [control("deploy_all_services")]);
    await click(
      button("openclaw:verify", "verify_block", "approved", "Approve"),
      {
        blocks: [
          { type: "divider" },
          neighbor,
          actions("verify_block", [control("openclaw:verify")]),
        ],
      },
      {
        threadTs: "100.100",
        team: { id: "T9" },
        trigger_id: "123.trigger",
        response_url: "https://hooks.slack.test/response",
      },
      { respond, context: { teamId: "T9" } },
    );
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "100.100",
      eventScope: expect.objectContaining({ teamId: "T9" }),
    });
    expect(slackInteractionPayload()).toMatchObject({
      actionId: "openclaw:verify",
      actionType: "button",
      value: "approved",
      triggerId: "[redacted]",
      responseUrl: "[redacted]",
    });
    expect(eventOptions()).toMatchObject({ deliveryContext: { to: "team:T9:channel:C1" } });
    expectUpdated(app, {
      blocks: [
        { type: "divider" },
        neighbor,
        confirmation(":white_check_mark: *Approve* selected by <@U123>"),
      ],
    });
  });

  it("routes plugin controls in a DM thread to the actor's canonical conversation", async () => {
    const { click } = setupInteractions({
      allowFrom: ["U_BINDER"],
      resolveChannelName: async () => ({ type: "im" }),
    });
    await click(
      {
        type: "button",
        action_id: "qa",
        value: "bind",
      },
      {},
      { userId: "U_BINDER", channelId: "D123", threadTs: "200.200" },
    );
    expect(pluginDispatchCall().conversation).toEqual({
      channel: "slack",
      accountId: "default",
      conversationId: "200.200",
      parentConversationId: "user:U_BINDER",
      threadId: "200.200",
    });
    expect(pluginDispatchCall().ctx).toMatchObject({
      conversationId: "D123",
      threadId: "200.200",
      auth: { isAuthorizedSender: true },
    });
  });

  it("passes false command auth to Slack plugin interactions for non-allowlisted senders", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce(pluginHandled);
    const { click } = setupInteractions({
      cfg: { commands: { allowFrom: { slack: ["U_OWNER"] } } },
    });
    await click(
      button("codex", "codex_actions", "approve:thread-1", "Approve"),
      buttonMessage("codex_actions", "codex"),
      { userId: "U_ALLOWED" },
    );
    expect(pluginDispatchCall().ctx.auth.isAuthorizedSender).toBe(false);
  });

  it("treats Slack reply buttons as plain interaction events instead of plugin dispatch", async () => {
    const { app, click, resolveSessionKey } = setupInteractions();

    await click(
      {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "reply_actions",
        action_ts: "100.201",
        value: "codex",
        text: plainText("codex"),
      },
      {
        thread_ts: "100.100",
        text: "fallback",
        blocks: singleButtonBlocks("reply_actions", "openclaw:reply_button"),
      },
    );

    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "100.100",
    });
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    const eventText = enqueueSystemEventText();
    expect(eventText).toContain('"actionId":"openclaw:reply_button"');
    expectRecordFields(eventOptions(), {
      contextKey: "slack:interaction:C1:100.200:openclaw:reply_button:100.201",
      deliveryContext: {
        accountId: "default",
        channel: "slack",
        threadId: "100.100",
        to: "channel:C1",
      },
      sessionKey: "agent:ops:slack:channel:C1",
    });
    expectSessionEvent("ops", "agent:ops:slack:channel:C1");
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("keeps typed callback payloads opaque even when they resemble approval commands", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue(pluginHandled);
    const { click } = setupInteractions();
    await click(button("openclaw:callback_button:1:1", "choice", "/approve req-1 deny", "Choose"));
    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(pluginDispatchCall().data).toBe("/approve req-1 deny");
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("uses unique interaction ids for repeated Slack actions on the same message", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: false,
      duplicate: false,
    });
    const { click } = setupInteractions();
    for (const trigger_id of ["trigger-1", "trigger-2"]) {
      await click(
        button("codex", "codex_actions", "approve:thread-1", "Approve"),
        buttonMessage("codex_actions", "codex"),
        { threadTs: "100.100", trigger_id },
      );
    }
    expect(pluginDispatchCall(0).dedupeId).toContain(":trigger-1:");
    expect(pluginDispatchCall(1).dedupeId).toContain(":trigger-2:");
    expect(pluginDispatchCall(0).dedupeId).not.toBe(pluginDispatchCall(1).dedupeId);
  });

  it("resolves plugin binding approvals from shared interactive Slack actions", async () => {
    resolvePluginConversationBindingApprovalMock.mockResolvedValueOnce(
      approvedPluginBindingResult(),
    );
    const { app, click } = setupInteractions();

    await click(
      button("openclaw:reply_button", "bind_actions", "pluginbind:approval-123:o", "Allow once"),
      buttonMessage("bind_actions", "openclaw:reply_button", "Approve this bind?"),
      {
        threadTs: "100.100",
      },
      { respond },
    );

    expect(resolvePluginConversationBindingApprovalMock).toHaveBeenCalledWith({
      approvalId: "approval-123",
      decision: "allow-once",
      senderId: "U123",
    });
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expectUpdated(app, {
      text: "Approve this bind?",
      blocks: [],
    });
    expectPrivateReply("Binding updated.");
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it.each([
    "resolved",
    "stale",
    "missing",
    "replacement",
    "wrong-kind",
    "update-failed",
    "expired",
    "malformed",
    "unauthorized",
  ] as const)("handles typed approval outcome: %s", async (outcome) => {
    const kind = ["missing", "replacement", "wrong-kind"].includes(outcome)
      ? "system-agent"
      : "exec";
    const approvalId = outcome === "resolved" ? "plugin:looks-plugin" : "req-123";
    const value =
      outcome === "malformed"
        ? 'openclaw:approval:v1:{"approvalId":"req-123","decision":"allow-once"}'
        : "openclaw:approval:v1:" +
          JSON.stringify({ approvalId, approvalKind: kind, decision: "allow-once" });
    const { ctx, app, click } = setupInteractions(execApprovalOptions());
    const neighbor = control("openclaw:reply_button");
    if (outcome === "stale") {
      resolveApprovalOverGatewayMock.mockResolvedValueOnce({
        applied: false,
        approval: { status: "denied", decision: "deny", presentation: { kind: "exec" } },
      });
    } else if (outcome === "expired") {
      resolveApprovalOverGatewayMock.mockRejectedValueOnce(
        new Error("unknown or expired approval id"),
      );
    }
    if (outcome !== "missing") {
      currentMessage([
        section("Current header", "openclaw_approval_header"),
        section("Command preview"),
        ...approvalButtonBlocks(
          outcome === "replacement" ? "replacement" : approvalId,
          outcome === "wrong-kind" ? "exec" : kind,
          "allow-once",
        ),
        ...approvalButtonBlocks(approvalId, kind, "deny"),
        actions("neighbors", [neighbor]),
      ]);
    }
    if (outcome === "update-failed") {
      app.client.chat.update.mockRejectedValueOnce(new Error("message update failed"));
    }
    await click(
      approvalButton(value),
      {
        blocks: [section("Obsolete snapshot", "openclaw_approval_header")],
      },
      { userId: outcome === "unauthorized" ? "U999" : "U123", threadTs: "100.100" },
      { respond },
    );
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    if (outcome === "malformed" || outcome === "unauthorized") {
      expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
      expectPrivateReply(
        outcome === "malformed"
          ? "This approval action is invalid or expired."
          : "You are not authorized to approve this request.",
      );
    } else {
      expectApproval(ctx.cfg, { approvalId, approvalKind: kind });
      if (outcome === "resolved" || outcome === "stale") {
        const label = outcome === "stale" ? "Already resolved: Denied" : "Resolved: Allowed once";
        expectUpdated(app, {
          text: label,
          blocks: [
            section("*" + label + "*"),
            section("Command preview"),
            actions("neighbors", [neighbor]),
          ],
        });
        if (outcome === "stale") {
          expectPrivateReply("This approval was already resolved: Denied.");
        } else {
          expect(respond).not.toHaveBeenCalled();
        }
      } else if (outcome === "expired") {
        expectPrivateReply("This approval is no longer pending.");
      } else {
        expectPrivateReply("Approval resolved: Allowed once.");
      }
    }
    if (!["resolved", "stale", "update-failed"].includes(outcome)) {
      expect(app.client.chat.update).not.toHaveBeenCalled();
    } else if (outcome === "update-failed") {
      expect(app.client.chat.update).toHaveBeenCalledOnce();
    }
  });

  it("authorizes plugin approval buttons only in the configured Grid workspace", async () => {
    currentMessage(approvalButtonBlocks("req-123", "plugin", "allow-once"));
    const { ctx, click } = setupInteractions({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                allowFrom: ["team:T11111111:user:U123OWNER"],
                execApprovals: { enabled: "auto", target: "dm" },
              },
            },
          },
        },
      },
    });
    const invoke = async (teamId: string) =>
      await click(
        approvalButton(
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-once"}',
          "plugin_actions",
        ),
        { text: "Plugin approval required", blocks: [] },
        { userId: "U123OWNER", channelId: "C11111111", team: { id: teamId } },
        { respond, context: { teamId } },
      );

    await invoke("T11111111");
    await invoke("T22222222");

    expect(readSlackMessagesMock).toHaveBeenCalledOnce();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledOnce();
    expectApproval(ctx.cfg, { approvalKind: "plugin", senderId: "team:T11111111:user:U123OWNER" });
    expectPrivateReply("You are not authorized to approve this request.");
  });

  it("resolves typed question buttons without enqueueing an agent interaction", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const { ctx, click } = setupInteractions();
    await click(
      button(
        "openclaw:question_button:1:2",
        "questions",
        "slq1:" + questionId + ":1",
        "Production",
      ),
      {},
      {},
      { respond },
    );
    expect(resolveQuestionOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      questionId,
      optionIndex: 1,
      senderId: "U123",
      clientDisplayName: "Slack question (default)",
    });
    expectPrivateReply("Answer submitted.");
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it.each(["fallback", "plugin-looking", "gateway-down", "unauthorized"] as const)(
    "resolves legacy approval: %s",
    async (scenario) => {
      const fallback = scenario === "fallback";
      const pluginLooking = scenario === "plugin-looking";
      const denied = scenario === "unauthorized";
      const sender = pluginLooking ? "U999EXEC" : denied ? "U123" : "U123OWNER";
      const approvalId = pluginLooking ? "plugin:req-123" : "req-legacy";
      const decision = pluginLooking ? "allow-always" : "allow-once";
      const { app, click } = setupInteractions(
        approvalContextOptions("U123OWNER", denied ? "U999" : sender),
      );
      if (fallback) {
        resolveApprovalOverGatewayMock.mockRejectedValueOnce(
          new Error("unknown or expired approval id"),
        );
      } else if (scenario === "gateway-down") {
        resolveApprovalOverGatewayMock.mockRejectedValueOnce(new Error("gateway down"));
      }
      const handling = click(
        button(
          "openclaw:reply_button",
          "approvals",
          "/approve " + approvalId + " " + decision,
          "Allow",
        ),
        buttonMessage("approvals", "openclaw:reply_button", "Approval required"),
        { userId: sender },
        { respond },
      );
      if (scenario === "gateway-down") {
        await expect(handling).rejects.toThrow("gateway down");
      } else {
        await handling;
      }
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
      expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
      if (denied) {
        expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
        expectPrivateReply("You are not authorized to approve this request.");
      } else {
        expect(resolveApprovalOverGatewayMock).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            approvalId,
            decision,
            senderId: sender,
            resolveMethod: "exec",
          }),
        );
        if (fallback) {
          expect(resolveApprovalOverGatewayMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
              approvalId,
              decision,
              senderId: sender,
              resolveMethod: "plugin",
            }),
          );
        }
      }
      if (denied || scenario === "gateway-down") {
        expect(app.client.chat.update).not.toHaveBeenCalled();
      } else {
        expectUpdated(app, { text: "Approval required", blocks: [] });
        expect(respond).not.toHaveBeenCalled();
      }
    },
  );

  it("drops block actions when mismatch guard triggers", async () => {
    const { app, click } = setupInteractions({
      shouldDropMismatchedSlackEvent: () => true,
    });

    await click(
      control("openclaw:verify"),
      { text: "fallback", blocks: [] },
      { team: { id: "T9" } },
      { respond },
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "submission", callbackId: "openclaw:deploy_form", acknowledged: true },
    { kind: "closed", callbackId: "openclaw:deploy_form", acknowledged: true },
    { kind: "submission", callbackId: "third_party_modal", acknowledged: false },
  ])(
    "filters $kind modal $callbackId before dispatch",
    async ({ kind, callbackId, acknowledged }) => {
      const { getViewHandler, getViewClosedHandler } = setupInteractions({
        shouldDropMismatchedSlackEvent: () => callbackId !== "third_party_modal",
      });
      const handler = kind === "closed" ? getViewClosedHandler() : getViewHandler();
      await handler({
        ack,
        body: viewBody(
          {
            id: "V123",
            callback_id: callbackId,
            ...(acknowledged ? { private_metadata: JSON.stringify({ userId: "U123" }) } : {}),
          },
          "U123",
          { team: { id: "T9" } },
        ),
      });
      expect(ack).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["blocks global outsiders", { allowFrom: ["U_OWNER"] }, "U_ATTACKER", "C1", false],
    [
      "allows channel members",
      {
        allowFrom: ["U_OWNER"],
        channelsConfig: { C1: { users: ["U_ALLOWED"] } },
      },
      "U_ALLOWED",
      "C1",
      true,
    ],
    [
      "does not let global wildcard bypass channel users",
      {
        allowFrom: ["*"],
        channelsConfig: { C1: { users: ["U_ALLOWED"] } },
      },
      "U_ATTACKER",
      "C1",
      false,
    ],
    ["allows unconfigured channels", { allowFrom: [] }, "U_ANYONE", "C1", true],
    [
      "blocks DM outsiders",
      { dmPolicy: "allowlist", allowFrom: ["U_OWNER"] },
      "U_ATTACKER",
      "D222",
      false,
    ],
    ["blocks MPIM outsiders", mpimPolicy(), "U_ATTACKER", "G_MPIM", false],
    ["allows MPIM members", mpimPolicy(), "U_OWNER", "G_MPIM", true],
  ] satisfies Array<
    [string, NonNullable<Parameters<typeof createContext>[0]>, string, string, boolean]
  >)("%s", async (_name, overrides, senderId, channelId, allowed) => {
    enqueueSessionEventMock.mockClear();
    const { app, click } = setupInteractions(overrides);

    await click(
      { type: "button", action_id: "openclaw:verify", block_id: "verify_block" },
      { blocks: [actions("verify_block", [])] },
      { userId: senderId, channelId, ts: "250.251", container: false },
      { respond },
    );

    if (allowed) {
      expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
      expect(app.client.chat.update).toHaveBeenCalledTimes(1);
      expect(respond).not.toHaveBeenCalled();
      return;
    }
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expectPrivateReply("You are not authorized to use this control.");
  });

  it("ignores malformed action payloads after ack and logs warning", async () => {
    const { app, click, runtimeLog } = setupInteractions();

    await click(
      "not-an-action-object" as unknown as Record<string, unknown>,
      buttonMessage("verify_block", "openclaw:verify"),
      {
        userId: "U666",
        ts: "777.888",
        container: false,
      },
    );

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledWith(
      "slack:interaction malformed action payload channel=C1 user=U666",
    );
  });

  it.each([
    [
      "escaped selection",
      "static_select",
      "openclaw:pick",
      { selected_option: { text: plainText("Canary_*`~<&>"), value: "canary" } },
      "Canary_*`~&lt;&amp;&gt;",
      false,
    ],
    [
      "multi-select summary",
      "multi_static_select",
      "openclaw:multi",
      {
        selected_options: [
          { text: plainText("Alpha"), value: "alpha" },
          { text: plainText("Beta"), value: "beta" },
          { text: plainText("Gamma"), value: "gamma" },
          { text: plainText("Delta"), value: "delta" },
        ],
      },
      "Alpha, Beta, Gamma +1",
      false,
    ],
    [
      "date with untouched neighbors",
      "datepicker",
      "openclaw:date",
      { selected_date: "2026-02-16" },
      "2026-02-16",
      true,
    ],
    ["time", "timepicker", "openclaw:time", { selected_time: "14:30" }, "14:30", false],
    [
      "datetime",
      "datetimepicker",
      "openclaw:datetime",
      { selected_date_time: 1_771_632_300 },
      new Date(1_771_632_300 * 1000).toISOString(),
      false,
    ],
    [
      "out-of-range datetime",
      "datetimepicker",
      "openclaw:datetime",
      { selected_date_time: 9_000_000_000_000 },
      "openclaw:datetime",
      false,
    ],
  ] satisfies Array<[string, string, string, Record<string, unknown>, string, boolean]>)(
    "renders %s confirmation",
    async (_name, type, actionId, selection, label, neighbors) => {
      const { app, click } = setupInteractions();
      const otherBlocks = neighbors
        ? [
            actions("time_block", [{ type: "timepicker", action_id: "openclaw:time" }]),
            actions("datetime_block", [{ type: "datetimepicker", action_id: "openclaw:datetime" }]),
          ]
        : [];
      await click(
        { type, action_id: actionId, block_id: "select_block", ...selection },
        {
          text: "fallback",
          blocks: [
            actions(
              "select_block",
              type === "static_select" ? [] : [{ type, action_id: actionId }],
            ),
            ...otherBlocks,
          ],
        },
        { userId: "U333", channelId: "C3", ts: "555.666", container: false },
      );
      expect(ack).toHaveBeenCalledOnce();
      expect(app.client.chat.update).toHaveBeenCalledOnce();
      if (type === "static_select") {
        expect(slackInteractionPayload()).toMatchObject({
          actionType: "static_select",
          selectedValues: ["canary"],
          selectedLabels: ["Canary_*`~<&>"],
        });
      }
      expectRecordFields(chatUpdateCall(app), {
        channel: "C3",
        ts: "555.666",
        blocks: [confirmation(`:white_check_mark: *${label}* selected by <@U333>`), ...otherBlocks],
      });
    },
  );

  it("falls back to container channel and message timestamps", async () => {
    const { app, act, resolveSessionKey } = setupInteractions();

    await act(
      {
        user: { id: "U111" },
        team: { id: "T111" },
        container: { channel_id: "C222", message_ts: "222.333", thread_ts: "222.111" },
      },
      button("openclaw:container", "container_block", "ok", "Container"),
    );

    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C222",
      channelType: "channel",
      senderId: "U111",
      threadTs: "222.111",
    });
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const payload = slackInteractionPayload();
    expectRecordFields(payload, {
      channelId: "C222",
      messageTs: "222.333",
      threadTs: "222.111",
      teamId: "T111",
    });
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("captures expanded selection and temporal payload fields", async () => {
    const { click } = setupInteractions();

    await click(
      {
        type: "multi_conversations_select",
        action_id: "openclaw:route",
        selected_user: "U777",
        selected_users: ["U777", "U888"],
        selected_channel: "C777",
        selected_channels: ["C777", "C888"],
        selected_conversation: "G777",
        selected_conversations: ["G777", "G888"],
        selected_options: [
          { text: plainText("Alpha"), value: "alpha" },
          { text: plainText("Alpha"), value: "alpha" },
          { text: plainText("Beta"), value: "beta" },
        ],
        selected_date: "2026-02-16",
        selected_time: "14:30",
        selected_date_time: 1_771_700_200,
      },
      {},
      { userId: "U321", channelId: "C2", ts: "222.333", container: false },
    );

    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    expectRecordFields(slackInteractionPayload(), {
      actionType: "multi_conversations_select",
      selectedValues: ["alpha", "beta", "U777", "U888", "C777", "C888", "G777", "G888"],
      selectedUsers: ["U777", "U888"],
      selectedChannels: ["C777", "C888"],
      selectedConversations: ["G777", "G888"],
      selectedLabels: ["Alpha", "Beta"],
      selectedDate: "2026-02-16",
      selectedTime: "14:30",
      selectedDateTime: 1_771_700_200,
    });
  });

  it("captures workflow button trigger metadata", async () => {
    const { click } = setupInteractions();
    await click({
      type: "workflow_button",
      action_id: "openclaw:workflow",
      workflow: {
        trigger_url: "https://slack.com/workflows/triggers/T420/12345",
        workflow_id: "Wf12345",
      },
    });
    expect(slackInteractionPayload()).toMatchObject({
      actionType: "workflow_button",
      workflowTriggerUrl: "[redacted]",
      workflowId: "Wf12345",
    });
  });

  it.each(["submission", "closed-channel", "closed-session"] as const)(
    "routes modal lifecycle: %s",
    async (mode) => {
      const recorded = mode === "closed-session";
      const submission = mode === "submission";
      const user = recorded ? "U900" : "U777";
      const metadata = recorded
        ? { sessionKey: "agent:main:slack:channel:C99" }
        : { channelId: submission ? "D123" : "C777", channelType: submission ? "im" : "channel" };
      const { getViewHandler, getViewClosedHandler, resolveSessionKey } = setupInteractions(
        submission
          ? { installationIdentity: { kind: "enterprise", enterpriseId: "E1" } }
          : undefined,
      );
      const handler = submission ? getViewHandler() : getViewClosedHandler();
      await handler({
        ack,
        ...(submission ? { context: { teamId: "T1" } } : {}),
        body: modalBody(
          user,
          metadata,
          {
            id: "V123",
            root_view_id: "VROOT",
            previous_view_id: "VPREV",
            external_id: "deploy-ext",
            hash: "view-hash",
            state: viewState({
              env_select: { type: "static_select", selected_option: option("Production", "prod") },
              notes_input: { type: "plain_text_input", value: "ship now" },
            }),
          },
          { ...(submission ? { team: { id: "T1" } } : {}), is_cleared: recorded },
        ),
      });
      const payload = slackInteractionPayload();
      expect(payload).toMatchObject({
        interactionType: submission ? "view_submission" : "view_closed",
        actionId: "view:openclaw:deploy_form",
        callbackId: "openclaw:deploy_form",
        viewId: "V123",
        userId: user,
        rootViewId: "VROOT",
        previousViewId: "VPREV",
        externalId: "deploy-ext",
        viewHash: "[redacted]",
        isStackedView: true,
        privateMetadata: "[redacted]",
        ...(!submission ? { isCleared: recorded } : {}),
      });
      const inputs = interactionInputs(payload);
      expect(inputByActionId(inputs, "env_select").selectedValues).toEqual(["prod"]);
      expect(inputByActionId(inputs, "notes_input").inputValue).toBe("ship now");
      expectSessionEvent(
        recorded ? "main" : "ops",
        recorded ? "agent:main:slack:channel:C99" : "agent:ops:slack:channel:C1",
      );
      expect(eventOptions()).toMatchObject({
        deliveryContext: {
          channel: "slack",
          accountId: "default",
          to: recorded ? undefined : submission ? "team:T1:user:U777" : "channel:C777",
        },
      });
      if (recorded) {
        expect(resolveSessionKey).not.toHaveBeenCalled();
      } else if (submission) {
        expect(resolveSessionKey).toHaveBeenCalledWith({
          channelId: "D123",
          channelType: "im",
          senderId: "U777",
          eventScope: expect.objectContaining({ teamId: "T1" }),
        });
      }
    },
  );

  it("dispatches plugin-owned modal submissions with full view state before compacting events", async () => {
    const systemEvent = { summary: "Contract form stored", reference: "contract-submission-123" };
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      ...pluginHandled,
      result: { systemEvent },
    });
    const { getViewHandler } = setupInteractions();
    const state = viewState(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          "field_" + i,
          { type: "plain_text_input", value: "value-" + i + "-" + "x".repeat(500) },
        ]),
      ),
    );
    await getViewHandler()({
      ack,
      body: modalBody(
        "U777",
        {
          channelId: "D777",
          channelType: "im",
          pluginInteractiveData: "dean.contract:confirm_hearing",
        },
        { id: "V777", callback_id: "contract_confirm_hearing", state },
        { team: { id: "T1" }, trigger_id: "trigger-777" },
      ),
    });
    const call = pluginDispatchCall();
    expect(call.data).toBe("dean.contract:confirm_hearing");
    expect(call.dedupeId).toBe("view_submission:contract_confirm_hearing:V777:U777");
    expect(call.conversation).toMatchObject({ conversationId: "user:U777" });
    expect(call.ctx.auth.isAuthorizedSender).toBe(true);
    expect(call.ctx.interaction).toMatchObject({
      kind: "view_submission",
      triggerId: "trigger-777",
    });
    const interaction = call.ctx.interaction;
    if (interaction.kind !== "view_submission") {
      throw new Error("Expected modal submission");
    }
    expect(interaction.inputs).toHaveLength(8);
    expect(interaction.stateValues).toEqual(state.values);
    expect(enqueueSystemEventText().length).toBeLessThanOrEqual(2400);
    const payload = slackInteractionPayload();
    expect(payload).toMatchObject({
      pluginHandled: true,
      pluginNamespace: "dean.contract",
      pluginSystemEvent: systemEvent,
      inputsOmitted: 5,
      payloadTruncated: true,
    });
    expect(interactionInputs(payload).length).toBeLessThanOrEqual(3);
  });

  it("dispatches callback-id-only plugin modal submissions without agent routing metadata", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce(pluginHandled);
    const { getViewHandler } = setupInteractions();
    await getViewHandler()({
      ack,
      body: viewBody(
        {
          id: "V778",
          callback_id: "openclaw:dean.contract:confirm_hearing",
          state: viewState({ name: { type: "plain_text_input", value: "Ari" } }),
        },
        "U777",
      ),
    });
    const call = pluginDispatchCall();
    expect(call.data).toBe("dean.contract:confirm_hearing");
    expect(call.dedupeId).toBe("view_submission:openclaw:dean.contract:confirm_hearing:V778:U777");
    expect(call.ctx.auth.isAuthorizedSender).toBe(false);
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("blocks modal events when private metadata userId does not match submitter", async () => {
    const { getViewHandler } = setupInteractions();

    await getViewHandler()({
      ack,
      body: modalBody("U222", { channelId: "D123", channelType: "im", userId: "U111" }),
    });

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("captures typed modal number, email, URL, and rich text inputs", async () => {
    const { getViewHandler } = setupInteractions({ allowFrom: [] });
    const rich = richText("Ship this now", "with canary metrics");
    await getViewHandler()({
      ack,
      body: modalBody(
        "U444",
        {},
        {
          callback_id: "openclaw:routing_form",
          state: viewState({
            number_input: { type: "number_input", value: "42.5" },
            email_input: { type: "email_text_input", value: "team@openclaw.ai" },
            url_input: { type: "url_text_input", value: "https://docs.openclaw.ai" },
            richtext_input: { type: "rich_text_input", rich_text_value: rich },
          }),
        },
      ),
    });
    const inputs = interactionInputs(slackInteractionPayload());
    expectRecordFields(inputByActionId(inputs, "number_input"), {
      inputKind: "number",
      inputNumber: 42.5,
    });
    expectRecordFields(inputByActionId(inputs, "email_input"), {
      inputKind: "email",
      inputEmail: "team@openclaw.ai",
    });
    expectRecordFields(inputByActionId(inputs, "url_input"), {
      inputKind: "url",
      inputUrl: "https://docs.openclaw.ai/",
    });
    expectRecordFields(inputByActionId(inputs, "richtext_input"), {
      inputKind: "rich_text",
      richTextPreview: "Ship this now with canary metrics",
      richTextValue: rich,
    });
  });

  it("sends a workspace-qualified reviewer for plugin buttons on workspace installs", async () => {
    resolveApprovalOverGatewayMock.mockResolvedValueOnce({
      applied: true,
      approval: { status: "allowed", decision: "allow-once", presentation: { kind: "plugin" } },
    });
    currentMessage(approvalButtonBlocks("req-123", "plugin", "allow-once"));
    const { ctx, act } = interactionContext({
      installationIdentity: { kind: "workspace", teamId: "T11111111" },
      cfg: {
        approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U123OWNER"] } } },
        channels: { slack: { allowFrom: ["U999LEGACY"] } },
      },
    });
    Object.assign(ctx, { teamId: "T11111111" });
    registerSlackInteractionEvents({ ctx: ctx as never });

    await act(
      {
        user: { id: "U123OWNER" },
        team: { id: "T11111111" },
        channel: { id: "C11111111" },
        container: { channel_id: "C11111111", message_ts: "100.200" },
        message: { ts: "100.200", text: "Plugin approval required", blocks: [] },
      },
      button(
        "openclaw:approval_button:1:1",
        "plugin_actions",
        'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-once"}',
        "Allow once",
      ),
      { respond },
    );

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "req-123",
        approvalKind: "plugin",
        senderId: "team:T11111111:user:U123OWNER",
      }),
    );
  });

  async function clickLinkButton(actionId: string, value?: string) {
    const { app, click } = setupInteractions();

    await click(
      {
        type: "button",
        action_id: actionId,
        block_id: "reply_actions",
        url: "https://example.com/app",
        ...(value ? { value } : {}),
        text: plainText("Launch"),
      },
      buttonMessage("reply_actions", actionId),
    );
    return app;
  }

  it.each([
    { name: "current", actionId: "openclaw:reply_link:1:1", value: undefined },
    { name: "additional session", actionId: "openclaw:session_link:1", value: undefined },
    { name: "legacy", actionId: "openclaw:reply_button:1:1", value: "/approve req-1 allow-once" },
  ])("ignores $name Slack callbacks emitted for link-only reply buttons", async (testCase) => {
    const app = await clickLinkButton(testCase.actionId, testCase.value);

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("routes unrelated buttons that only share the session-link prefix", async () => {
    await clickLinkButton("openclaw:session_linked");

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
