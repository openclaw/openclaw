import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { encodeSlackApprovalAction } from "../../approval-actions.js";
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

type UnknownMock = { mock: { calls: unknown[][] } };

function mockCallArg(mock: unknown, index: number, label: string, argIndex = 0): unknown {
  const calls = (mock as UnknownMock).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`Expected ${label} to be a mock`);
  }
  const call = calls.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call[argIndex];
}

const requireRecord = createRequireRecord("object", "expected-label-capitalized");

function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });
}

function expectRecordFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

function pluginDispatchCall(index = 0) {
  const call = dispatchPluginInteractiveHandlerMock.mock.calls[index]?.[0];
  if (!call) {
    throw new Error("Expected plugin interactive dispatch");
  }
  return call;
}

function slackInteractionPayload(callIndex = 0): Record<string, unknown> {
  const eventText = mockCallArg(enqueueSessionEventMock, callIndex, "enqueueSystemEvent");
  if (typeof eventText !== "string") {
    throw new Error("Expected Slack interaction event text");
  }
  return JSON.parse(eventText.replace("Slack interaction: ", "")) as Record<string, unknown>;
}

function eventOptions() {
  return requireRecord(
    mockCallArg(enqueueSessionEventMock, 0, "enqueueSystemEvent", 1),
    "event options",
  );
}

function enqueueSystemEventText(callIndex = 0): string {
  const eventText = mockCallArg(enqueueSessionEventMock, callIndex, "enqueueSystemEvent");
  if (typeof eventText !== "string") {
    throw new Error("Expected Slack interaction event text");
  }
  return eventText;
}

function chatUpdateCall(app: { client: { chat: { update: unknown } } }, callIndex = 0) {
  return requireRecord(
    mockCallArg(app.client.chat.update, callIndex, "chat.update"),
    "chat.update",
  );
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
    act: (
      body: ActionArgs["body"],
      action: ActionArgs["action"],
      extra: Omit<ActionArgs, "ack" | "body" | "action"> = {},
    ) => context.getHandler()({ ack, body, action, ...extra }),
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
  it("routes global shortcuts to the actor's direct session", async () => {
    const { ctx, getShortcutHandler, resolveSessionKey } = interactionContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
    });
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    await getShortcutHandler()({ ack, context: { teamId: "T9" }, body: shortcutBody() });

    expect(ack).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledOnce();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: undefined,
      channelType: "im",
      senderId: "U123",
      threadTs: undefined,
      eventScope: expect.objectContaining({ teamId: "T9" }),
    });
    expect(slackInteractionPayload()).toMatchObject({
      interactionType: "global_shortcut",
      actionId: "shortcut:capture-note",
      callbackId: "capture-note",
      userId: "U123",
      teamId: "T9",
      triggerId: "[redacted]",
      actionTs: "100.200",
    });
    expect(enqueueSystemEventText()).not.toContain("secret");
    expect(eventOptions()).toMatchObject({
      sessionKey: "agent:ops:slack:channel:C1",
      deliveryContext: { channel: "slack", to: "team:T9:user:U123", accountId: "default" },
    });
    expect(captureSessionEventTargetMock).toHaveBeenCalledOnce();
  });

  it("routes message shortcuts with selected-message context", async () => {
    const { getShortcutHandler, resolveSessionKey } = setupInteractions({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
      resolveChannelName: async () => ({ name: "ops", type: "channel" }),
    });

    await getShortcutHandler()({
      ack,
      context: { teamId: "T9" },
      body: {
        type: "message_action",
        callback_id: "summarize-message",
        trigger_id: "456.trigger",
        response_url: "https://hooks.slack.test/response",
        message_ts: "200.300",
        message: {
          type: "message",
          user: "U456",
          ts: "200.300",
          text: "Selected message",
          thread_ts: "200.100",
        },
        user: { id: "U123", name: "ada", team_id: "T9" },
        channel: { id: "C1", name: "ops" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "200.400",
      },
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "200.100",
      eventScope: expect.objectContaining({ teamId: "T9" }),
    });
    expect(slackInteractionPayload()).toMatchObject({
      interactionType: "message_shortcut",
      actionId: "shortcut:summarize-message",
      callbackId: "summarize-message",
      channelId: "C1",
      channelName: "ops",
      messageTs: "200.300",
      threadTs: "200.100",
      messageUserId: "U456",
      messageText: "Selected message",
      triggerId: "[redacted]",
      responseUrl: "[redacted]",
    });
    expect(enqueueSystemEventText()).not.toContain("secret");
    expect(eventOptions()).toMatchObject({
      deliveryContext: {
        channel: "slack",
        to: "team:T9:channel:C1",
        accountId: "default",
        threadId: "200.100",
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
    const { ctx, app, act, resolveSessionKey } = interactionContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
    });
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    await act(
      actionBody(
        {
          text: "fallback",
          blocks: [
            { type: "divider" },
            actions("deploy_row", [
              {
                type: "button",
                action_id: "deploy_all_services",
                text: plainText("Deploy all services"),
              },
            ]),
            actions("verify_block", [control("openclaw:verify")]),
          ],
        },
        {
          threadTs: "100.100",
          team: { id: "T9" },
          trigger_id: "123.trigger",
          response_url: "https://hooks.slack.test/response",
        },
      ),
      button("openclaw:verify", "verify_block", "approved", "Approve"),
      { respond, context: { teamId: "T9" } },
    );

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const eventText = mockCallArg(enqueueSessionEventMock, 0, "enqueueSystemEvent");
    expect(typeof eventText === "string" && eventText.startsWith("Slack interaction: ")).toBe(true);
    const payload = slackInteractionPayload();
    expectRecordFields(payload, {
      actionId: "openclaw:verify",
      actionType: "button",
      value: "approved",
      userId: "U123",
      teamId: "T9",
      triggerId: "[redacted]",
      responseUrl: "[redacted]",
      channelId: "C1",
      messageTs: "100.200",
      threadTs: "100.100",
    });
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "100.100",
      eventScope: expect.objectContaining({ teamId: "T9" }),
    });
    expect(eventOptions()).toMatchObject({ deliveryContext: { to: "team:T9:channel:C1" } });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      blocks: [
        { type: "divider" },
        actions("deploy_row", [
          {
            type: "button",
            action_id: "deploy_all_services",
            text: plainText("Deploy all services"),
          },
        ]),
        confirmation(":white_check_mark: *Approve* selected by <@U123>"),
      ],
    });
  });

  it("routes plugin controls in a DM thread to the actor's canonical conversation", async () => {
    const { act } = setupInteractions({
      allowFrom: ["U_BINDER"],
      resolveChannelName: async () => ({ type: "im" }),
    });
    await act(actionBody({}, { userId: "U_BINDER", channelId: "D123", threadTs: "200.200" }), {
      type: "button",
      action_id: "qa",
      value: "bind",
    });
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
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({ ...pluginHandled });
    const { act } = setupInteractions({
      cfg: {
        commands: { allowFrom: { slack: ["U_OWNER"] } },
      },
    });

    await act(
      actionBody(buttonMessage("codex_actions", "codex"), {
        userId: "U_ALLOWED",
        threadTs: "100.100",
      }),
      {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
      },
    );

    const dispatchCall = pluginDispatchCall();
    const registrationCtx = dispatchCall.ctx;
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(false);
  });

  it("treats Slack reply buttons as plain interaction events instead of plugin dispatch", async () => {
    const { app, act, resolveSessionKey } = setupInteractions();

    await act(
      actionBody({
        thread_ts: "100.100",
        text: "fallback",
        blocks: singleButtonBlocks("reply_actions", "openclaw:reply_button"),
      }),
      {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "reply_actions",
        action_ts: "100.201",
        value: "codex",
        text: plainText("codex"),
      },
    );

    expect(ack).toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    const eventText = mockCallArg(enqueueSessionEventMock, 0, "enqueueSystemEvent");
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
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "100.100",
    });
    expectSessionEvent("ops", "agent:ops:slack:channel:C1");
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("keeps typed callback payloads opaque even when they resemble approval commands", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({ ...pluginHandled });
    const { act } = setupInteractions();

    await act(actionBody({ text: "Choose", blocks: [] }), {
      type: "button",
      action_id: "openclaw:callback_button:1:1",
      value: "/approve req-1 deny",
      text: plainText("Choose"),
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expectRecordFields(
      requireRecord(
        mockCallArg(dispatchPluginInteractiveHandlerMock, 0, "plugin interactive dispatcher"),
        "plugin interactive dispatcher",
      ),
      { data: "/approve req-1 deny" },
    );
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("uses unique interaction ids for repeated Slack actions on the same message", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: false,
      duplicate: false,
    });
    const { act } = setupInteractions();

    await act(
      actionBody(buttonMessage("codex_actions", "codex"), {
        threadTs: "100.100",
        trigger_id: "trigger-1",
      }),
      button("codex", "codex_actions", "approve:thread-1", "Approve"),
    );
    await act(
      actionBody(buttonMessage("codex_actions", "codex"), {
        threadTs: "100.100",
        trigger_id: "trigger-2",
      }),
      button("codex", "codex_actions", "approve:thread-1", "Approve"),
    );

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(2);
    const firstCall = pluginDispatchCall(0);
    const secondCall = pluginDispatchCall(1);
    expect(firstCall.dedupeId).toContain(":trigger-1:");
    expect(secondCall.dedupeId).toContain(":trigger-2:");
    expect(firstCall.dedupeId).not.toBe(secondCall.dedupeId);
  });

  it("resolves plugin binding approvals from shared interactive Slack actions", async () => {
    resolvePluginConversationBindingApprovalMock.mockResolvedValueOnce(
      approvedPluginBindingResult(),
    );
    const { app, act } = setupInteractions();

    await act(
      actionBody(buttonMessage("bind_actions", "openclaw:reply_button", "Approve this bind?"), {
        threadTs: "100.100",
      }),
      button("openclaw:reply_button", "bind_actions", "pluginbind:approval-123:o", "Allow once"),
      { respond },
    );

    expect(ack).toHaveBeenCalled();
    expect(resolvePluginConversationBindingApprovalMock).toHaveBeenCalledWith({
      approvalId: "approval-123",
      decision: "allow-once",
      senderId: "U123",
    });
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Approve this bind?",
      blocks: [],
    });
    expectPrivateReply("Binding updated.");
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("resolves typed exec approvals from Slack-private action data", async () => {
    currentMessage([
      actions("exec_actions", [
        {
          type: "button",
          action_id: "openclaw:approval_button:1:1",
          value:
            'openclaw:approval:v1:{"approvalId":"plugin:looks-plugin","approvalKind":"exec","decision":"allow-once"}',
        },
        control("openclaw:reply_button"),
      ]),
    ]);
    const { ctx, app, act } = setupInteractions(execApprovalOptions());

    await act(
      actionBody(
        {
          text: "Exec approval required",
          blocks: [
            actions("exec_actions", [
              control("openclaw:approval_button:1:1"),
              control("openclaw:reply_button"),
            ]),
          ],
        },
        { threadTs: "100.100" },
      ),
      approvalButton(
        'openclaw:approval:v1:{"approvalId":"plugin:looks-plugin","approvalKind":"exec","decision":"allow-once"}',
      ),
      { respond },
    );

    expect(ack).toHaveBeenCalled();
    expectApproval(ctx.cfg, { approvalId: "plugin:looks-plugin" });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Resolved: Allowed once",
      blocks: [
        section("*Resolved: Allowed once*"),
        actions("exec_actions", [control("openclaw:reply_button")]),
      ],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a missing current message", current: "missing" },
    { name: "a replacement approval card", current: "replacement" },
    { name: "a card for a different approval kind", current: "different-kind" },
  ] as const)(
    "registered approval handler reads $name after mocked resolution",
    async ({ current }) => {
      const approvalId = "system-agent:0d939e63-1c97-4b53-9c6f-6caae6d95bd0";
      resolveApprovalOverGatewayMock.mockResolvedValueOnce({
        applied: true,
        approval: {
          status: "allowed",
          decision: "allow-once",
          presentation: { kind: "system-agent" },
        },
      });
      const header = section("OpenClaw change approval required", "openclaw_approval_header");
      readSlackMessagesMock.mockResolvedValueOnce({
        messages:
          current === "missing"
            ? []
            : [
                {
                  ts: "100.200",
                  blocks:
                    current === "replacement"
                      ? approvalButtonBlocks("replacement", "system-agent", "allow-once")
                      : approvalButtonBlocks(approvalId, "exec", "allow-once"),
                },
              ],
        hasMore: false,
      });
      const { ctx, app, act } = setupInteractions(execApprovalOptions());
      await act(
        actionBody(
          {
            text: "Incoming snapshot is still pending",
            blocks: [header, ...approvalButtonBlocks(approvalId, "system-agent", "allow-once")],
          },
          { threadTs: "100.100" },
        ),
        {
          type: "button",
          action_id: "openclaw:approval_button:1:1",
          block_id: "exec_actions",
          value: encodeSlackApprovalAction({
            type: "approval",
            approvalId,
            approvalKind: "system-agent",
            decision: "allow-once",
          }),
          text: plainText("Allow once"),
        },
        { respond },
      );
      expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
        cfg: ctx.cfg,
        approvalId,
        approvalKind: "system-agent",
        decision: "allow-once",
        senderId: "U123",
        channel: "slack",
        accountId: "default",
      });
      expect(readSlackMessagesMock).toHaveBeenCalledExactlyOnceWith("C1", {
        client: app.client,
        messageId: "100.200",
        threadId: "100.100",
      });
      expect(app.client.chat.update).not.toHaveBeenCalled();
      expectPrivateReply("Approval resolved: Allowed once.");
    },
  );

  it("blocks non-approvers from resolving system-agent approvals before resolution", async () => {
    const { act } = setupInteractions(execApprovalOptions());

    await act(
      actionBody(
        {
          text: "OpenClaw change approval required",
          blocks: [actions("exec_actions", [control("openclaw:approval_button:1:1")])],
        },
        { userId: "U999", threadTs: "100.100" },
      ),
      approvalButton(
        'openclaw:approval:v1:{"approvalId":"system-agent:0d939e63-1c97-4b53-9c6f-6caae6d95bd0","approvalKind":"system-agent","decision":"deny"}',
        "exec_actions",
        "Deny",
      ),
      { respond },
    );

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expectPrivateReply("You are not authorized to approve this request.");
  });

  it("authorizes plugin approval buttons only in the configured Grid workspace", async () => {
    currentMessage(approvalButtonBlocks("req-123", "plugin", "allow-once"));
    const { ctx, act } = setupInteractions({
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
      await act(
        actionBody(
          { text: "Plugin approval required", blocks: [] },
          { userId: "U123OWNER", channelId: "C11111111", team: { id: teamId } },
        ),
        approvalButton(
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-once"}',
          "plugin_actions",
        ),
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
    const { ctx, act } = setupInteractions();

    await act(
      actionBody({ text: "Question", blocks: [] }),
      button(
        "openclaw:question_button:1:2",
        "openclaw_reply_buttons_1",
        `slq1:${questionId}:1`,
        "Production",
      ),
      { respond },
    );

    expect(ack).toHaveBeenCalledOnce();
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

  it("cleans stale typed buttons and shows the canonical first-answer winner", async () => {
    currentMessage([
      section("Current approval header", "openclaw_approval_header"),
      section("Command preview"),
      ...approvalButtonBlocks("req-123", "exec", "allow-once"),
      ...approvalButtonBlocks("req-123", "exec", "deny"),
    ]);
    resolveApprovalOverGatewayMock.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny", presentation: { kind: "exec" } },
    });
    const { ctx, app, act } = setupInteractions();

    await act(
      actionBody({
        text: "Exec approval required",
        blocks: [
          section("Approval copy can change independently.", "openclaw_approval_header"),
          section("Command preview"),
          actions("exec_actions", [
            control("openclaw:approval_button:1:1"),
            control("openclaw:approval_button:1:2"),
          ]),
        ],
      }),
      approvalButton(
        'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
      ),
      { respond },
    );

    expectApproval(ctx.cfg);
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Already resolved: Denied",
      blocks: [section("*Already resolved: Denied*"), section("Command preview")],
    });
    expectPrivateReply("This approval was already resolved: Denied.");
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "message update fails", updateFails: true, text: "Approval resolved: Allowed once." },
    {
      name: "approval is no longer pending",
      updateFails: false,
      text: "This approval is no longer pending.",
    },
  ])("reports canonical approval truth when $name", async ({ updateFails, text }) => {
    const { app, act } = setupInteractions();
    if (updateFails) {
      currentMessage(approvalButtonBlocks("req-123", "exec", "allow-once"));
      app.client.chat.update.mockRejectedValueOnce(new Error("message update failed"));
    } else {
      resolveApprovalOverGatewayMock.mockRejectedValueOnce(
        new Error("unknown or expired approval id"),
      );
    }
    await act(
      actionBody({ text: "Exec approval required", blocks: [] }),
      approvalButton(
        'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
      ),
      { respond },
    );
    expect(app.client.chat.update).toHaveBeenCalledTimes(updateFails ? 1 : 0);
    expect(respond).toHaveBeenCalledWith({ text, response_type: "ephemeral" });
  });

  it("fails closed for malformed Slack approval envelopes", async () => {
    const { app, act } = setupInteractions();

    await act(
      actionBody({ text: "Exec approval required", blocks: [] }),
      approvalButton('openclaw:approval:v1:{"approvalId":"req-123","decision":"allow-once"}'),
      { respond },
    );

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expectPrivateReply("This approval action is invalid or expired.");
  });

  it("preserves legacy unprefixed fallback when the sender may approve either kind", async () => {
    resolveApprovalOverGatewayMock
      .mockRejectedValueOnce(new Error("unknown or expired approval id"))
      .mockResolvedValueOnce({
        applied: true,
        approval: { status: "allowed", decision: "allow-once", presentation: { kind: "exec" } },
      });
    const { ctx, app, act } = setupInteractions(approvalContextOptions("U123OWNER", "U123OWNER"));

    await act(
      actionBody(
        buttonMessage("plugin_actions", "openclaw:reply_button", "Plugin approval required"),
        { userId: "U123OWNER" },
      ),
      button(
        "openclaw:reply_button",
        "plugin_actions",
        "/approve req-legacy allow-once",
        "Allow once",
      ),
    );

    const expectedCommon = {
      cfg: ctx.cfg,
      approvalId: "req-legacy",
      decision: "allow-once",
      senderId: "U123OWNER",
      channel: "slack",
      accountId: "default",
    };
    expect(resolveApprovalOverGatewayMock).toHaveBeenNthCalledWith(1, {
      ...expectedCommon,
      resolveMethod: "exec",
    });
    expect(resolveApprovalOverGatewayMock).toHaveBeenNthCalledWith(2, {
      ...expectedCommon,
      resolveMethod: "plugin",
    });
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Plugin approval required",
      blocks: [],
    });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("does not treat a plugin-looking legacy id as an owner signal", async () => {
    const { ctx, app, act } = setupInteractions(approvalContextOptions("U123OWNER", "U999EXEC"));

    await act(
      actionBody(
        buttonMessage("plugin_actions", "openclaw:reply_button", "Plugin approval required"),
        { userId: "U999EXEC" },
      ),
      button(
        "openclaw:reply_button",
        "plugin_actions",
        "/approve plugin:req-123 allow-always",
        "Always allow",
      ),
      { respond },
    );

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "plugin:req-123",
      decision: "allow-always",
      senderId: "U999EXEC",
      resolveMethod: "exec",
      channel: "slack",
      accountId: "default",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Plugin approval required",
      blocks: [],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("keeps exec approval buttons when gateway resolution fails", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValueOnce(new Error("gateway down"));
    const { app, act } = setupInteractions();

    await expect(
      act(
        actionBody(
          buttonMessage("exec_actions", "openclaw:reply_button", "Exec approval required"),
        ),
        button(
          "openclaw:reply_button",
          "exec_actions",
          "/approve req-123 allow-once",
          "Allow once",
        ),
      ),
    ).rejects.toThrow("gateway down");

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("rejects unauthorized exec approval interactions without enqueueing them", async () => {
    const { app, act } = setupInteractions({
      cfg: {
        channels: {
          slack: { execApprovals: { enabled: true, approvers: ["U999"], target: "both" } },
        },
      },
    });

    await act(
      actionBody(buttonMessage("exec_actions", "openclaw:reply_button", "Exec approval required")),
      button("openclaw:reply_button", "exec_actions", "/approve req-123 allow-once", "Allow once"),
      { respond },
    );

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expectPrivateReply("You are not authorized to approve this request.");
  });

  it("drops block actions when mismatch guard triggers", async () => {
    const { app, act } = setupInteractions({
      shouldDropMismatchedSlackEvent: () => true,
    });

    await act(
      actionBody({ text: "fallback", blocks: [] }, { team: { id: "T9" } }),
      control("openclaw:verify"),
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
    {
      name: "blocks channel block actions when sender is outside configured global allowFrom",
      overrides: { allowFrom: ["U_OWNER"] },
      senderId: "U_ATTACKER",
      channelId: "C1",
      timestamp: "250.251",
      allowed: false,
    },
    {
      name: "allows channel block actions when channel users allowlist authorizes the sender",
      overrides: {
        allowFrom: ["U_OWNER"],
        channelsConfig: { C1: { users: ["U_ALLOWED"] } },
      },
      senderId: "U_ALLOWED",
      channelId: "C1",
      timestamp: "260.261",
      allowed: true,
    },
    {
      name: "blocks wildcard global allowFrom from bypassing configured channel users",
      overrides: {
        allowFrom: ["*"],
        channelsConfig: { C1: { users: ["U_ALLOWED"] } },
      },
      senderId: "U_ATTACKER",
      channelId: "C1",
      timestamp: "270.271",
      allowed: false,
    },
    {
      name: "keeps channel block actions open when no allowlists are configured",
      overrides: { allowFrom: [] },
      senderId: "U_ANYONE",
      channelId: "C1",
      timestamp: "305.306",
      allowed: true,
    },
    {
      name: "blocks DM block actions when sender is not in allowFrom",
      overrides: { dmPolicy: "allowlist" as const, allowFrom: ["U_OWNER"] },
      senderId: "U_ATTACKER",
      channelId: "D222",
      timestamp: "301.302",
      allowed: false,
    },
    {
      name: "blocks MPIM block actions when sender is outside configured allowFrom",
      overrides: {
        allowFrom: ["U_OWNER"],
        resolveChannelName: async () => ({ name: "group-dm", type: "mpim" as const }),
      },
      senderId: "U_ATTACKER",
      channelId: "G_MPIM",
      timestamp: "311.312",
      allowed: false,
    },
    {
      name: "allows MPIM block actions when sender is in configured allowFrom",
      overrides: {
        allowFrom: ["U_OWNER"],
        resolveChannelName: async () => ({ name: "group-dm", type: "mpim" as const }),
      },
      senderId: "U_OWNER",
      channelId: "G_MPIM",
      timestamp: "313.314",
      allowed: true,
    },
  ])("$name", async ({ overrides, senderId, channelId, timestamp, allowed }) => {
    enqueueSessionEventMock.mockClear();
    const { app, act } = setupInteractions(overrides);

    await act(
      actionBody(
        { blocks: [actions("verify_block", [])] },
        { userId: senderId, channelId, ts: timestamp, container: false },
      ),
      { type: "button", action_id: "openclaw:verify", block_id: "verify_block" },
      { respond },
    );

    expect(ack).toHaveBeenCalled();
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
    const { app, act, runtimeLog } = setupInteractions();

    await act(
      actionBody(buttonMessage("verify_block", "openclaw:verify"), {
        userId: "U666",
        ts: "777.888",
        container: false,
      }),
      "not-an-action-object" as unknown as Record<string, unknown>,
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
      const { app, act } = setupInteractions();
      const otherBlocks = neighbors
        ? [
            actions("time_block", [{ type: "timepicker", action_id: "openclaw:time" }]),
            actions("datetime_block", [{ type: "datetimepicker", action_id: "openclaw:datetime" }]),
          ]
        : [];
      await act(
        actionBody(
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
        ),
        { type, action_id: actionId, block_id: "select_block", ...selection },
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

    expect(ack).toHaveBeenCalled();
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
    const { act } = setupInteractions();

    await act(
      actionBody({}, { userId: "U321", channelId: "C2", ts: "222.333", container: false }),
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
    );

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const payload = slackInteractionPayload();
    expect(payload.actionType).toBe("multi_conversations_select");
    expect(payload.selectedValues).toEqual([
      "alpha",
      "beta",
      "U777",
      "U888",
      "C777",
      "C888",
      "G777",
      "G888",
    ]);
    expect(payload.selectedUsers).toEqual(["U777", "U888"]);
    expect(payload.selectedChannels).toEqual(["C777", "C888"]);
    expect(payload.selectedConversations).toEqual(["G777", "G888"]);
    expect(payload.selectedLabels).toEqual(["Alpha", "Beta"]);
    expect(payload.selectedDate).toBe("2026-02-16");
    expect(payload.selectedTime).toBe("14:30");
    expect(payload.selectedDateTime).toBe(1_771_700_200);
  });

  it("captures workflow button trigger metadata", async () => {
    const { act } = setupInteractions();

    await act(
      actionBody(
        {},
        {
          userId: "U420",
          channelId: "C420",
          ts: "420.420",
          container: false,
          team: { id: "T420" },
        },
      ),
      {
        type: "workflow_button",
        action_id: "openclaw:workflow",
        block_id: "workflow_block",
        text: plainText("Launch workflow"),
        workflow: {
          trigger_url: "https://slack.com/workflows/triggers/T420/12345",
          workflow_id: "Wf12345",
        },
      },
    );

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const payload = slackInteractionPayload();
    expectRecordFields(payload, {
      actionType: "workflow_button",
      workflowTriggerUrl: "[redacted]",
      workflowId: "Wf12345",
      teamId: "T420",
      channelId: "C420",
    });
  });

  it("captures modal submissions and enqueues view submission event", async () => {
    const { ctx, getViewHandler, resolveSessionKey } = interactionContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
    });
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    await getViewHandler()({
      ack,
      context: { teamId: "T1" },
      body: viewBody(
        {
          id: "V123",
          callback_id: "openclaw:deploy_form",
          root_view_id: "VROOT",
          previous_view_id: "VPREV",
          external_id: "deploy-ext-1",
          hash: "view-hash-1",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
            userId: "U777",
          }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: { text: plainText("Production"), value: "prod" },
                },
              },
              notes_block: { notes_input: { type: "plain_text_input", value: "ship now" } },
            },
          },
        },
        "U777",
        { team: { id: "T1" } },
      ),
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777",
      eventScope: expect.objectContaining({ teamId: "T1" }),
    });
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    expect(eventOptions()).toMatchObject({
      sessionKey: "agent:ops:slack:channel:C1",
      deliveryContext: { channel: "slack", to: "team:T1:user:U777", accountId: "default" },
    });
    expectSessionEvent("ops", "agent:ops:slack:channel:C1");
    const payload = slackInteractionPayload();
    expectRecordFields(payload, {
      interactionType: "view_submission",
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      viewId: "V123",
      userId: "U777",
      routedChannelId: "D123",
      rootViewId: "VROOT",
      previousViewId: "VPREV",
      externalId: "deploy-ext-1",
      viewHash: "[redacted]",
      isStackedView: true,
    });
    const inputs = interactionInputs(payload);
    const envInput = inputByActionId(inputs, "env_select");
    const notesInput = inputByActionId(inputs, "notes_input");
    expect(envInput?.selectedValues).toEqual(["prod"]);
    expect(notesInput?.inputValue).toBe("ship now");
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("routes accepted view_closed events back to their authorized Slack channel", async () => {
    const { getViewClosedHandler } = setupInteractions();

    await getViewClosedHandler()({
      ack,
      body: viewBody(
        {
          id: "V777",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "C777",
            channelType: "channel",
            userId: "U777",
          }),
        },
        "U777",
      ),
    });

    expect(eventOptions()).toMatchObject({
      deliveryContext: { channel: "slack", to: "channel:C777", accountId: "default" },
    });
    expect(slackInteractionPayload()).toMatchObject({
      interactionType: "view_closed",
      isCleared: false,
    });
    expect(captureSessionEventTargetMock).toHaveBeenCalledOnce();
  });

  it("dispatches plugin-owned modal submissions with full view state before compacting events", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
      result: {
        systemEvent: { summary: "Contract form stored", reference: "contract-submission-123" },
      },
    });
    const { ctx, getViewHandler } = setupInteractions();
    const values: Record<string, Record<string, Record<string, unknown>>> = {};
    for (let index = 0; index < 8; index += 1) {
      values[`field_block_${index}`] = {
        [`field_${index}`]: {
          type: "plain_text_input",
          value: `value-${index}-${"x".repeat(500)}`,
        },
      };
    }

    await getViewHandler()({
      ack,
      body: viewBody(
        {
          id: "V777",
          callback_id: "contract_confirm_hearing",
          private_metadata: JSON.stringify({
            channelId: "D777",
            channelType: "im",
            userId: "U777",
            pluginInteractiveData: "dean.contract:confirm_hearing",
          }),
          state: {
            values,
          },
        },
        "U777",
        { team: { id: "T1" }, trigger_id: "trigger-777" },
      ),
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCall = pluginDispatchCall();
    expectRecordFields(requireRecord(dispatchCall, "dispatch call"), {
      data: "dean.contract:confirm_hearing",
      dedupeId: "view_submission:contract_confirm_hearing:V777:U777",
    });

    expect(dispatchCall.conversation).toEqual({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U777",
      parentConversationId: undefined,
      threadId: undefined,
    });
    const registrationCtx = dispatchCall.ctx;
    expectRecordFields(registrationCtx, {
      accountId: ctx.accountId,
      conversationId: "D777",
      senderId: "U777",
    });
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(true);

    const interaction = requireRecord(registrationCtx.interaction, "registration interaction") as {
      inputs?: unknown[];
      stateValues?: unknown;
    };
    expectRecordFields(interaction, {
      kind: "view_submission",
      callbackId: "contract_confirm_hearing",
      viewId: "V777",
      triggerId: "trigger-777",
    });
    expect(interaction.inputs).toHaveLength(8);
    expect(interaction.stateValues).toEqual(values);

    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    expect(eventText.length).toBeLessThanOrEqual(2400);
    const payload = slackInteractionPayload();
    expectRecordFields(payload, { pluginHandled: true, pluginNamespace: "dean.contract" });
    expect(payload.pluginSystemEvent).toEqual({
      summary: "Contract form stored",
      reference: "contract-submission-123",
    });
    expect(Array.isArray(payload.inputs) ? payload.inputs.length : 0).toBeLessThanOrEqual(3);
    expect(payload.inputsOmitted).toBe(5);
    expect(payload.payloadTruncated).toBe(true);
  });

  it("dispatches callback-id-only plugin modal submissions without agent routing metadata", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({ ...pluginHandled });
    const { getViewHandler } = setupInteractions();

    await getViewHandler()({
      ack,
      body: viewBody(
        {
          id: "V778",
          callback_id: "openclaw:dean.contract:confirm_hearing",
          state: {
            values: {
              contract: { name: { type: "plain_text_input", value: "Ari" } },
            },
          },
        },
        "U777",
      ),
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCall = pluginDispatchCall();
    expectRecordFields(requireRecord(dispatchCall, "dispatch call"), {
      data: "dean.contract:confirm_hearing",
      dedupeId: "view_submission:openclaw:dean.contract:confirm_hearing:V778:U777",
    });

    const registrationCtx = dispatchCall.ctx;
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(false);

    expectRecordFields(requireRecord(registrationCtx.interaction, "registration interaction"), {
      kind: "view_submission",
      callbackId: "openclaw:dean.contract:confirm_hearing",
      viewId: "V778",
    });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("blocks modal events when private metadata userId does not match submitter", async () => {
    const { getViewHandler } = setupInteractions();

    await getViewHandler()({
      ack,
      body: viewBody(
        {
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
            userId: "U111",
          }),
        },
        "U222",
      ),
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("captures typed modal number, email, URL, and rich text inputs", async () => {
    const { getViewHandler } = setupInteractions({ allowFrom: [] });

    await getViewHandler()({
      ack,
      body: viewBody(
        {
          id: "V400",
          callback_id: "openclaw:routing_form",
          private_metadata: JSON.stringify({ userId: "U444" }),
          state: {
            values: {
              number_block: { number_input: { type: "number_input", value: "42.5" } },
              email_block: {
                email_input: { type: "email_text_input", value: "team@openclaw.ai" },
              },
              url_block: {
                url_input: { type: "url_text_input", value: "https://docs.openclaw.ai" },
              },
              richtext_block: {
                richtext_input: {
                  type: "rich_text_input",
                  rich_text_value: richText("Ship this now", "with canary metrics"),
                },
              },
            },
          },
        },
        "U444",
      ),
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const payload = slackInteractionPayload();
    const inputs = interactionInputs(payload);
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
      richTextValue: richText("Ship this now", "with canary metrics"),
    });
  });

  it("captures modal close events and enqueues view closed event", async () => {
    const { ctx, getViewClosedHandler, resolveSessionKey } = interactionContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    await getViewClosedHandler()({
      ack,
      body: viewBody(
        {
          id: "V900",
          callback_id: "openclaw:deploy_form",
          root_view_id: "VROOT900",
          previous_view_id: "VPREV900",
          external_id: "deploy-ext-900",
          hash: "view-hash-900",
          private_metadata: JSON.stringify({
            sessionKey: "agent:main:slack:channel:C99",
            userId: "U900",
          }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: { text: plainText("Canary"), value: "canary" },
                },
              },
            },
          },
        },
        "U900",
        { team: { id: "T1" }, is_cleared: true },
      ),
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const options = eventOptions() as { sessionKey?: string };
    const payload = slackInteractionPayload();
    expectRecordFields(payload, {
      interactionType: "view_closed",
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      viewId: "V900",
      userId: "U900",
      isCleared: true,
      privateMetadata: "[redacted]",
      rootViewId: "VROOT900",
      previousViewId: "VPREV900",
      externalId: "deploy-ext-900",
      viewHash: "[redacted]",
      isStackedView: true,
    });
    expect(inputByActionId(interactionInputs(payload), "env_select").selectedValues).toEqual([
      "canary",
    ]);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(options.sessionKey).toBe("agent:main:slack:channel:C99");
    expect(options).toMatchObject({ deliveryContext: { channel: "slack", accountId: "default" } });
    expectSessionEvent("main", "agent:main:slack:channel:C99");
  });

  it("keeps block action rich text previews UTF-16 safe at the truncation boundary", async () => {
    const { act } = setupInteractions();

    const boundaryText = `${"x".repeat(118)}😀y`;
    await act(
      actionBody(
        {
          text: "fallback",
          blocks: [actions("richtext_block", [])],
        },
        { userId: "U555", ts: "111.222", container: false },
      ),
      {
        type: "rich_text_input",
        action_id: "openclaw:richtext",
        block_id: "richtext_block",
        rich_text_value: richText(boundaryText),
      },
    );

    expect(ack).toHaveBeenCalled();
    const payload = slackInteractionPayload() as { richTextPreview?: string };
    expect(payload.richTextPreview).toBe(`${"x".repeat(118)}…`);
    expect(payload.richTextPreview?.length).toBeLessThanOrEqual(120);
    expect(hasLoneSurrogate(payload.richTextPreview ?? "")).toBe(false);
    expect(() => encodeURIComponent(payload.richTextPreview ?? "")).not.toThrow();
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
    const { app, act } = setupInteractions();

    await act(actionBody(buttonMessage("reply_actions", actionId)), {
      type: "button",
      action_id: actionId,
      block_id: "reply_actions",
      url: "https://example.com/app",
      ...(value ? { value } : {}),
      text: plainText("Launch"),
    });
    expect(ack).toHaveBeenCalled();
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
