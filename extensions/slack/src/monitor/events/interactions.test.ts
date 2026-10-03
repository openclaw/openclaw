// Slack tests cover interactions plugin behavior.
import type { createChannelInteractiveDispatcher } from "openclaw/plugin-sdk/plugin-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSlackApprovalAction } from "../../approval-actions.js";
import type { SlackInteractiveHandlerContext } from "../../interactive-dispatch.js";
import {
  approvalButtonBlocks,
  approvalContextOptions,
  createContext,
  singleButtonBlocks,
} from "./interactions.test-support.js";

const enqueueSessionEventMock = vi.hoisted(() => vi.fn());
const readSlackMessagesMock = vi.hoisted(() =>
  vi.fn<typeof import("../../actions.js").readSlackMessages>(),
);
type DispatchPluginInteractiveHandlerResult = {
  matched: boolean;
  handled: boolean;
  duplicate: boolean;
  result?: unknown;
};
type PluginDispatchParams = Parameters<
  ReturnType<
    typeof createChannelInteractiveDispatcher<
      "slack",
      "interaction",
      SlackInteractiveHandlerContext
    >
  >
>[0];
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() =>
  vi.fn<(arg: PluginDispatchParams) => Promise<DispatchPluginInteractiveHandlerResult>>(),
);
const resolvePluginConversationBindingApprovalMock = vi.hoisted(() => vi.fn());
const buildPluginBindingResolvedTextMock = vi.hoisted(() => vi.fn(() => "Binding updated."));
type ApprovalResolveMockResult = {
  applied: boolean;
  approval: { presentation: { kind: "exec" | "plugin" | "system-agent" } } & (
    | { status: "allowed"; decision: "allow-once" | "allow-always" }
    | { status: "denied"; decision: "deny" }
    | { status: "expired" | "cancelled" }
  );
};
const resolveApprovalOverGatewayMock = vi.hoisted(() =>
  vi.fn<(arg: unknown) => Promise<ApprovalResolveMockResult>>(async (_arg: unknown) => ({
    applied: true,
    approval: { status: "allowed", decision: "allow-once", presentation: { kind: "exec" } },
  })),
);
const resolveQuestionOverGatewayMock = vi.hoisted(() =>
  vi.fn(async (_arg: unknown) => ({
    status: "answered" as const,
    questionId: "target",
    optionValue: "Production",
  })),
);

let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  getSlackRuntime: () => ({ system: { enqueueSessionEvent: enqueueSessionEventMock } }),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (arg: unknown) => resolveApprovalOverGatewayMock(arg),
}));

vi.mock("../../actions.js", () => ({ readSlackMessages: readSlackMessagesMock }));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: {
    resolveOption: (arg: unknown) => resolveQuestionOverGatewayMock(arg),
  },
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    createChannelInteractiveDispatcher: () => dispatchPluginInteractiveHandlerMock,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();

  return {
    ...actual,
    buildPluginBindingResolvedText: (...args: unknown[]) =>
      (buildPluginBindingResolvedTextMock as (...innerArgs: unknown[]) => string)(...args),
    resolvePluginConversationBindingApproval: (...args: unknown[]) =>
      (
        resolvePluginConversationBindingApprovalMock as (
          ...innerArgs: unknown[]
        ) => Promise<unknown>
      )(...args),
  };
});

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
  const eventText = mockCallArg(enqueueSessionEventMock, callIndex, "enqueueSessionEvent");
  if (typeof eventText !== "string") {
    throw new Error("Expected Slack interaction event text");
  }
  return JSON.parse(eventText.replace("Slack interaction: ", "")) as Record<string, unknown>;
}

function enqueueSessionEventText(callIndex = 0): string {
  const eventText = mockCallArg(enqueueSessionEventMock, callIndex, "enqueueSessionEvent");
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

function plainText(text: string) {
  return { type: "plain_text", text };
}
function confirmation(text: string) {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function setupInteractions(options?: Parameters<typeof createContext>[0]) {
  const context = createContext(options);
  registerSlackInteractionEvents({ ctx: context.ctx as never });
  return context;
}

function interactionInputs(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.inputs)) {
    throw new Error("Expected interaction inputs");
  }
  return payload.inputs.map((input) => requireRecord(input, "interaction input"));
}

type ActionBody = Parameters<ReturnType<ReturnType<typeof createContext>["getHandler"]>>[0]["body"];
function actionBody(
  message: Omit<NonNullable<ActionBody["message"]>, "ts">,
  {
    userId = "U123",
    channelId = "C1",
    ts = "100.200",
    threadTs,
    container = true,
    ...extra
  }: {
    userId?: string;
    channelId?: string;
    ts?: string;
    threadTs?: string;
    container?: boolean;
  } & Pick<ActionBody, "team" | "trigger_id" | "response_url"> = {},
): ActionBody {
  return {
    user: { id: userId },
    channel: { id: channelId },
    ...(container
      ? { container: { channel_id: channelId, message_ts: ts, thread_ts: threadTs } }
      : {}),
    message: { ts, ...message },
    ...extra,
  };
}

describe("registerSlackInteractionEvents", () => {
  beforeAll(async () => {
    ({ registerSlackInteractionEvents } = await import("./interactions.js"));
  });

  beforeEach(() => {
    readSlackMessagesMock.mockReset();
    readSlackMessagesMock.mockResolvedValue({ messages: [], hasMore: false });
    enqueueSessionEventMock.mockReset();
    enqueueSessionEventMock.mockReturnValue({
      id: "interaction",
      cancel: vi.fn(),
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
    });
    dispatchPluginInteractiveHandlerMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockResolvedValue({ status: "expired" });
    buildPluginBindingResolvedTextMock.mockClear();
    buildPluginBindingResolvedTextMock.mockReturnValue("Binding updated.");
    resolveApprovalOverGatewayMock.mockClear();
    resolveApprovalOverGatewayMock.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once", presentation: { kind: "exec" } },
    });
    resolveQuestionOverGatewayMock.mockClear();
    resolveQuestionOverGatewayMock.mockResolvedValue({
      status: "answered",
      questionId: "target",
      optionValue: "Production",
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: false,
      handled: false,
      duplicate: false,
    });
  });

  it("routes global shortcuts to the actor's direct session", async () => {
    const { ctx, getShortcutHandler, resolveSessionKey } = createContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
    });
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    const ack = vi.fn().mockResolvedValue(undefined);
    await getShortcutHandler()({
      ack,
      context: { teamId: "T9" },
      body: {
        type: "shortcut",
        callback_id: "capture-note",
        trigger_id: "123.trigger",
        user: { id: "U123", username: "ada", team_id: "T9" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "100.200",
      },
    });

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
    expect(enqueueSessionEventText()).not.toContain("secret");
    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
      sessionKey: "agent:ops:slack:channel:C1",
      deliveryContext: {
        channel: "slack",
        to: "team:T9:user:U123",
        accountId: "default",
      },
    });
  });

  it("routes message shortcuts with selected-message context", async () => {
    const { getShortcutHandler, resolveSessionKey } = setupInteractions({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
      resolveChannelName: async () => ({ name: "ops", type: "channel" }),
    });

    await getShortcutHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
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
    expect(enqueueSessionEventText()).not.toContain("secret");
    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
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
      body: {
        type: "shortcut",
        callback_id: "capture-note",
        trigger_id: "123.trigger",
        user: { id: "U123", username: "ada", team_id: "T9" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "100.200",
      },
    });

    expect(order).toEqual(["ack", "filter"]);
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("enforces DM policy for global shortcuts", async () => {
    const { getShortcutHandler } = setupInteractions({
      dmEnabled: false,
      dmPolicy: "disabled",
    });

    await getShortcutHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        type: "shortcut",
        callback_id: "capture-note",
        trigger_id: "123.trigger",
        user: { id: "U123", username: "ada", team_id: "T9" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "100.200",
      },
    });

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("enqueues structured events and updates button rows", async () => {
    const { ctx, app, getHandler, resolveSessionKey } = createContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
    });
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      context: { teamId: "T9" },
      body: actionBody(
        {
          text: "fallback",
          blocks: [
            { type: "divider" },
            {
              type: "actions",
              block_id: "deploy_row",
              elements: [
                {
                  type: "button",
                  action_id: "deploy_all_services",
                  text: plainText("Deploy all services"),
                },
              ],
            },
            {
              type: "actions",
              block_id: "verify_block",
              elements: [{ type: "button", action_id: "openclaw:verify" }],
            },
          ],
        },
        {
          threadTs: "100.100",
          team: { id: "T9" },
          trigger_id: "123.trigger",
          response_url: "https://hooks.slack.test/response",
        },
      ),
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
        value: "approved",
        text: plainText("Approve"),
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const eventText = mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent");
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
    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
      deliveryContext: { to: "team:T9:channel:C1" },
    });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      blocks: [
        { type: "divider" },
        {
          type: "actions",
          block_id: "deploy_row",
          elements: [
            {
              type: "button",
              action_id: "deploy_all_services",
              text: plainText("Deploy all services"),
            },
          ],
        },
        confirmation(":white_check_mark: *Approve* selected by <@U123>"),
      ],
    });
  });

  it("routes matching Slack actions through the shared plugin interactive dispatcher", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { ctx, app, getHandler, getActionMatcher } = setupInteractions({
      cfg: { commands: { allowFrom: { slack: ["U123"] } } },
    });
    expect(getActionMatcher().test("openclaw:verify")).toBe(true);
    expect(getActionMatcher().test("codex")).toBe(true);

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody(
        { text: "fallback", blocks: singleButtonBlocks("codex_actions", "codex") },
        {
          threadTs: "100.100",
          team: { id: "T9" },
          trigger_id: "123.trigger",
          response_url: "https://hooks.slack.test/response",
        },
      ),
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
        text: plainText("Approve"),
      },
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCall = pluginDispatchCall();
    expectRecordFields(requireRecord(dispatchCall, "dispatch call"), {
      data: "codex:approve:thread-1",
      dedupeId: "U123:C1:100.200:123.trigger:codex:approve:thread-1",
    });
    expect(dispatchCall.conversation).toEqual({
      channel: "slack",
      accountId: "default",
      conversationId: "100.100",
      parentConversationId: "C1",
      threadId: "100.100",
    });
    const registrationCtx = dispatchCall.ctx;
    expectRecordFields(registrationCtx, {
      accountId: ctx.accountId,
      conversationId: "C1",
      interactionId: "U123:C1:100.200:123.trigger:codex:approve:thread-1",
      threadId: "100.100",
    });
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(true);
    expectRecordFields(requireRecord(registrationCtx.interaction, "registration interaction"), {
      actionId: "codex",
      value: "approve:thread-1",
    });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("routes plugin controls in a DM thread to the actor's canonical conversation", async () => {
    const { getHandler } = setupInteractions({
      allowFrom: ["U_BINDER"],
      resolveChannelName: async () => ({ type: "im" }),
    });
    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: actionBody({}, { userId: "U_BINDER", channelId: "D123", threadTs: "200.200" }),
      action: { type: "button", action_id: "qa", value: "bind" },
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
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { getHandler } = setupInteractions({
      cfg: {
        commands: {
          allowFrom: {
            slack: ["U_OWNER"],
          },
        },
      },
    });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        { text: "fallback", blocks: singleButtonBlocks("codex_actions", "codex") },
        { userId: "U_ALLOWED", threadTs: "100.100" },
      ),
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
      },
    });

    const dispatchCall = pluginDispatchCall();
    const registrationCtx = dispatchCall.ctx;
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(false);
  });

  it("treats Slack reply buttons as plain interaction events instead of plugin dispatch", async () => {
    const { app, getHandler, resolveSessionKey } = setupInteractions();

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody({
        thread_ts: "100.100",
        text: "fallback",
        blocks: singleButtonBlocks("reply_actions", "openclaw:reply_button"),
      }),
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "reply_actions",
        action_ts: "100.201",
        value: "codex",
        text: plainText("codex"),
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    const eventText = mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent");
    expect(eventText).toContain('"actionId":"openclaw:reply_button"');
    expectRecordFields(
      requireRecord(
        mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1),
        "event options",
      ),
      {
        contextKey: "slack:interaction:C1:100.200:openclaw:reply_button:100.201",
        deliveryContext: {
          accountId: "default",
          channel: "slack",
          threadId: "100.100",
          to: "channel:C1",
        },
        sessionKey: "agent:ops:slack:channel:C1",
      },
    );
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "100.100",
    });
    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
      agentId: "ops",
      sessionKey: "agent:ops:slack:channel:C1",
    });
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("keeps typed callback payloads opaque even when they resemble approval commands", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { getHandler } = setupInteractions();

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: actionBody({ text: "Choose", blocks: [] }),
      action: {
        type: "button",
        action_id: "openclaw:callback_button:1:1",
        value: "/approve req-1 deny",
        text: plainText("Choose"),
      },
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
    const { getHandler } = setupInteractions();

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        { text: "fallback", blocks: singleButtonBlocks("codex_actions", "codex") },
        { threadTs: "100.100", trigger_id: "trigger-1" },
      ),
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
        text: plainText("Approve"),
      },
    });
    await handler({
      ack,
      body: actionBody(
        { text: "fallback", blocks: singleButtonBlocks("codex_actions", "codex") },
        { threadTs: "100.100", trigger_id: "trigger-2" },
      ),
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
        text: plainText("Approve"),
      },
    });

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(2);
    const firstCall = pluginDispatchCall(0);
    const secondCall = pluginDispatchCall(1);
    expect(firstCall.dedupeId).toContain(":trigger-1:");
    expect(secondCall.dedupeId).toContain(":trigger-2:");
    expect(firstCall.dedupeId).not.toBe(secondCall.dedupeId);
  });

  it("resolves plugin binding approvals from shared interactive Slack actions", async () => {
    resolvePluginConversationBindingApprovalMock.mockResolvedValueOnce({
      status: "approved",
      decision: "allow-once",
      request: {
        pluginId: "codex",
        pluginName: "Codex",
        summary: "for this thread",
      },
    });
    const { app, getHandler } = setupInteractions();

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody(
        {
          text: "Approve this bind?",
          blocks: singleButtonBlocks("bind_actions", "openclaw:reply_button"),
        },
        { threadTs: "100.100" },
      ),
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "bind_actions",
        value: "pluginbind:approval-123:o",
        text: plainText("Allow once"),
      },
    });

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
    expect(respond).toHaveBeenCalledWith({
      text: "Binding updated.",
      response_type: "ephemeral",
    });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("resolves typed exec approvals from Slack-private action data", async () => {
    readSlackMessagesMock.mockResolvedValueOnce({
      messages: [
        {
          ts: "100.200",
          blocks: [
            {
              type: "actions",
              block_id: "exec_actions",
              elements: [
                {
                  type: "button",
                  action_id: "openclaw:approval_button:1:1",
                  value:
                    'openclaw:approval:v1:{"approvalId":"plugin:looks-plugin","approvalKind":"exec","decision":"allow-once"}',
                },
                { type: "button", action_id: "openclaw:reply_button" },
              ],
            },
          ],
        },
      ],
      hasMore: false,
    });
    const { ctx, app, getHandler } = setupInteractions({
      allowFrom: ["U999"],
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["u123"],
              target: "both",
            },
          },
        },
      },
    });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody(
        {
          text: "Exec approval required",
          blocks: [
            {
              type: "actions",
              block_id: "exec_actions",
              elements: [
                { type: "button", action_id: "openclaw:approval_button:1:1" },
                { type: "button", action_id: "openclaw:reply_button" },
              ],
            },
          ],
        },
        { threadTs: "100.100" },
      ),
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"plugin:looks-plugin","approvalKind":"exec","decision":"allow-once"}',
        text: plainText("Allow once"),
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "plugin:looks-plugin",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "U123",
      channel: "slack",
      accountId: "default",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Resolved: Allowed once",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Resolved: Allowed once*" },
        },
        {
          type: "actions",
          block_id: "exec_actions",
          elements: [{ type: "button", action_id: "openclaw:reply_button" }],
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "current pending controls with a native header",
      current: "header-pending",
      applied: true,
      requestKind: "system-agent",
      updates: true,
    },
    {
      name: "current Applied card",
      current: "applied",
      applied: true,
      requestKind: "system-agent",
      updates: false,
    },
    {
      name: "another approval's current controls",
      current: "replacement",
      applied: true,
      requestKind: "system-agent",
      updates: false,
    },
    {
      name: "a missing current message",
      current: "missing",
      applied: true,
      requestKind: "system-agent",
      updates: false,
    },
    {
      name: "current controls that do not match the stale request kind",
      current: "pending",
      applied: false,
      requestKind: "exec",
      updates: false,
    },
  ] as const)(
    "registered approval handler reads $name after mocked resolution",
    async ({ current, applied, requestKind, updates }) => {
      const approvalId = "system-agent:0d939e63-1c97-4b53-9c6f-6caae6d95bd0";
      resolveApprovalOverGatewayMock.mockResolvedValueOnce({
        applied,
        approval: {
          status: "allowed",
          decision: "allow-once",
          presentation: { kind: "system-agent" },
        },
      });
      const header = {
        type: "section",
        block_id: "openclaw_approval_header",
        text: { type: "mrkdwn", text: "OpenClaw change approval required" },
      };
      const currentBlocks =
        current === "applied"
          ? [{ type: "section", text: { type: "mrkdwn", text: "Applied" } }]
          : [
              ...(current === "header-pending" ? [header] : []),
              ...approvalButtonBlocks(
                current === "replacement" ? "replacement" : approvalId,
                "system-agent",
                "allow-once",
              ),
            ];
      readSlackMessagesMock.mockResolvedValueOnce({
        messages: current === "missing" ? [] : [{ ts: "100.200", blocks: currentBlocks }],
        hasMore: false,
      });
      const { ctx, app, getHandler } = setupInteractions({
        allowFrom: ["U999"],
        cfg: {
          channels: {
            slack: {
              execApprovals: { enabled: true, approvers: ["u123"], target: "both" },
            },
          },
        },
      });
      const respond = vi.fn().mockResolvedValue(undefined);
      await getHandler()({
        ack: vi.fn().mockResolvedValue(undefined),
        respond,
        body: actionBody(
          {
            text: "Incoming snapshot is still pending",
            blocks: [header, ...approvalButtonBlocks(approvalId, requestKind, "allow-once")],
          },
          { threadTs: "100.100" },
        ),
        action: {
          type: "button",
          action_id: "openclaw:approval_button:1:1",
          block_id: "exec_actions",
          value: encodeSlackApprovalAction({
            type: "approval",
            approvalId,
            approvalKind: requestKind,
            decision: "allow-once",
          }),
          text: plainText("Allow once"),
        },
      });
      expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
        cfg: ctx.cfg,
        approvalId,
        approvalKind: requestKind,
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
      if (updates) {
        const prefix = applied ? "Resolved" : "Already resolved";
        expectRecordFields(chatUpdateCall(app), {
          channel: "C1",
          ts: "100.200",
          text: prefix + ": Allowed once",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "*" + prefix + ": Allowed once*" } },
          ],
        });
      } else {
        expect(app.client.chat.update).not.toHaveBeenCalled();
      }
      if (!updates || !applied) {
        expect(respond).toHaveBeenCalledWith({
          text: applied
            ? "Approval resolved: Allowed once."
            : "This approval was already resolved: Allowed once.",
          response_type: "ephemeral",
        });
      } else {
        expect(respond).not.toHaveBeenCalled();
      }
    },
  );

  it("blocks non-approvers from resolving system-agent approvals before resolution", async () => {
    const { getHandler } = setupInteractions({
      allowFrom: ["U999"],
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["u123"],
              target: "both",
            },
          },
        },
      },
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: actionBody(
        {
          text: "OpenClaw change approval required",
          blocks: [
            {
              type: "actions",
              block_id: "exec_actions",
              elements: [{ type: "button", action_id: "openclaw:approval_button:1:1" }],
            },
          ],
        },
        { userId: "U999", threadTs: "100.100" },
      ),
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"system-agent:0d939e63-1c97-4b53-9c6f-6caae6d95bd0","approvalKind":"system-agent","decision":"deny"}',
        text: plainText("Deny"),
      },
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to approve this request.",
      response_type: "ephemeral",
    });
  });

  it("authorizes plugin approval buttons only in the configured Grid workspace", async () => {
    readSlackMessagesMock.mockResolvedValueOnce({
      messages: [
        { ts: "100.200", blocks: approvalButtonBlocks("req-123", "plugin", "allow-once") },
      ],
      hasMore: false,
    });
    const { ctx, getHandler } = setupInteractions({
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
    const handler = getHandler();
    const respond = vi.fn().mockResolvedValue(undefined);
    const invoke = async (teamId: string) =>
      await handler({
        ack: vi.fn().mockResolvedValue(undefined),
        respond,
        context: { teamId },
        body: actionBody(
          { text: "Plugin approval required", blocks: [] },
          { userId: "U123OWNER", channelId: "C11111111", team: { id: teamId } },
        ),
        action: {
          type: "button",
          action_id: "openclaw:approval_button:1:1",
          block_id: "plugin_actions",
          value:
            'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-once"}',
          text: plainText("Allow once"),
        },
      });

    await invoke("T11111111");
    await invoke("T22222222");

    expect(readSlackMessagesMock).toHaveBeenCalledOnce();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledOnce();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-123",
      approvalKind: "plugin",
      decision: "allow-once",
      senderId: "team:T11111111:user:U123OWNER",
      channel: "slack",
      accountId: "default",
    });
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to approve this request.",
      response_type: "ephemeral",
    });
  });

  it("resolves typed question buttons without enqueueing an agent interaction", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const { ctx, getHandler } = setupInteractions();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack,
      respond,
      body: actionBody({ text: "Question", blocks: [] }),
      action: {
        type: "button",
        action_id: "openclaw:question_button:1:2",
        block_id: "openclaw_reply_buttons_1",
        value: `slq1:${questionId}:1`,
        text: plainText("Production"),
      },
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(resolveQuestionOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      questionId,
      optionIndex: 1,
      senderId: "U123",
      clientDisplayName: "Slack question (default)",
    });
    expect(respond).toHaveBeenCalledWith({
      text: "Answer submitted.",
      response_type: "ephemeral",
    });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("cleans stale typed buttons and shows the canonical first-answer winner", async () => {
    readSlackMessagesMock.mockResolvedValueOnce({
      messages: [
        {
          ts: "100.200",
          blocks: [
            {
              type: "section",
              block_id: "openclaw_approval_header",
              text: { type: "mrkdwn", text: "Current approval header" },
            },
            { type: "section", text: { type: "mrkdwn", text: "Command preview" } },
            ...approvalButtonBlocks("req-123", "exec", "allow-once"),
            ...approvalButtonBlocks("req-123", "exec", "deny"),
          ],
        },
      ],
      hasMore: false,
    });
    resolveApprovalOverGatewayMock.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny", presentation: { kind: "exec" } },
    });
    const { ctx, app, getHandler } = setupInteractions();

    const respond = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: actionBody({
        text: "Exec approval required",
        blocks: [
          {
            type: "section",
            block_id: "openclaw_approval_header",
            text: { type: "mrkdwn", text: "Approval copy can change independently." },
          },
          { type: "section", text: { type: "mrkdwn", text: "Command preview" } },
          {
            type: "actions",
            block_id: "exec_actions",
            elements: [
              { type: "button", action_id: "openclaw:approval_button:1:1" },
              { type: "button", action_id: "openclaw:approval_button:1:2" },
            ],
          },
        ],
      }),
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
        text: plainText("Allow once"),
      },
    });

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-123",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "U123",
      channel: "slack",
      accountId: "default",
    });
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Already resolved: Denied",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Already resolved: Denied*" },
        },
        { type: "section", text: { type: "mrkdwn", text: "Command preview" } },
      ],
    });
    expect(respond).toHaveBeenCalledWith({
      text: "This approval was already resolved: Denied.",
      response_type: "ephemeral",
    });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("shows canonical typed approval truth when the clicked message update fails", async () => {
    readSlackMessagesMock.mockResolvedValueOnce({
      messages: [{ ts: "100.200", blocks: approvalButtonBlocks("req-123", "exec", "allow-once") }],
      hasMore: false,
    });
    const { app, getHandler } = setupInteractions();
    app.client.chat.update.mockRejectedValueOnce(new Error("message update failed"));
    const respond = vi.fn().mockResolvedValue(undefined);

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: actionBody({ text: "Exec approval required", blocks: [] }),
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
        text: plainText("Allow once"),
      },
    });

    expect(app.client.chat.update).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      text: "Approval resolved: Allowed once.",
      response_type: "ephemeral",
    });
  });

  it("tells the clicker when a typed approval is no longer pending", async () => {
    const { app, getHandler } = setupInteractions();
    resolveApprovalOverGatewayMock.mockRejectedValueOnce(
      new Error("unknown or expired approval id"),
    );
    const respond = vi.fn().mockResolvedValue(undefined);

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: actionBody({ text: "Exec approval required", blocks: [] }),
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
        text: plainText("Allow once"),
      },
    });

    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This approval is no longer pending.",
      response_type: "ephemeral",
    });
  });

  it("fails closed for malformed Slack approval envelopes", async () => {
    const { app, getHandler } = setupInteractions();

    const respond = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: actionBody({ text: "Exec approval required", blocks: [] }),
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value: 'openclaw:approval:v1:{"approvalId":"req-123","decision":"allow-once"}',
        text: plainText("Allow once"),
      },
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This approval action is invalid or expired.",
      response_type: "ephemeral",
    });
  });

  it("uses the typed plugin kind for unprefixed approval ids", async () => {
    readSlackMessagesMock.mockResolvedValueOnce({
      messages: [
        { ts: "100.200", blocks: approvalButtonBlocks("req-123", "plugin", "allow-always") },
      ],
      hasMore: false,
    });
    const { ctx, app, getHandler } = setupInteractions(
      approvalContextOptions("u123owner", "U999EXEC"),
    );

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody(
        {
          text: "Plugin approval required",
          blocks: singleButtonBlocks("plugin_actions", "openclaw:approval_button:1:1"),
        },
        { userId: "U123OWNER" },
      ),
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "plugin_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-always"}',
        text: plainText("Always allow"),
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-123",
      approvalKind: "plugin",
      decision: "allow-always",
      senderId: "U123OWNER",
      channel: "slack",
      accountId: "default",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Resolved: Allowed once",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Resolved: Allowed once*" },
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("routes opaque legacy ids through the authorized plugin adapter", async () => {
    const { ctx, app, getHandler } = setupInteractions(
      approvalContextOptions("u123owner", "U999EXEC"),
    );

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody(
        {
          text: "Plugin approval required",
          blocks: singleButtonBlocks("plugin_actions", "openclaw:reply_button"),
        },
        { userId: "U123OWNER" },
      ),
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "plugin_actions",
        value: "/approve req-legacy allow-once",
        text: plainText("Allow once"),
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-legacy",
      decision: "allow-once",
      senderId: "U123OWNER",
      resolveMethod: "plugin",
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

  it("preserves legacy unprefixed fallback when the sender may approve either kind", async () => {
    resolveApprovalOverGatewayMock
      .mockRejectedValueOnce(new Error("unknown or expired approval id"))
      .mockResolvedValueOnce({
        applied: true,
        approval: { status: "allowed", decision: "allow-once", presentation: { kind: "exec" } },
      });
    const { ctx, app, getHandler } = setupInteractions(
      approvalContextOptions("U123OWNER", "U123OWNER"),
    );

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: actionBody(
        {
          text: "Plugin approval required",
          blocks: singleButtonBlocks("plugin_actions", "openclaw:reply_button"),
        },
        { userId: "U123OWNER" },
      ),
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "plugin_actions",
        value: "/approve req-legacy allow-once",
        text: plainText("Allow once"),
      },
    });

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
    const { ctx, app, getHandler } = setupInteractions(
      approvalContextOptions("U123OWNER", "U999EXEC"),
    );

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody(
        {
          text: "Plugin approval required",
          blocks: singleButtonBlocks("plugin_actions", "openclaw:reply_button"),
        },
        { userId: "U999EXEC" },
      ),
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "plugin_actions",
        value: "/approve plugin:req-123 allow-always",
        text: plainText("Always allow"),
      },
    });

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
    const { app, getHandler } = setupInteractions();

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await expect(
      handler({
        ack,
        body: actionBody({
          text: "Exec approval required",
          blocks: singleButtonBlocks("exec_actions", "openclaw:reply_button"),
        }),
        action: {
          type: "button",
          action_id: "openclaw:reply_button",
          block_id: "exec_actions",
          value: "/approve req-123 allow-once",
          text: plainText("Allow once"),
        },
      }),
    ).rejects.toThrow("gateway down");

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("rejects unauthorized exec approval interactions without enqueueing them", async () => {
    const { app, getHandler } = setupInteractions({
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["U999"],
              target: "both",
            },
          },
        },
      },
    });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody({
        text: "Exec approval required",
        blocks: singleButtonBlocks("exec_actions", "openclaw:reply_button"),
      }),
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "exec_actions",
        value: "/approve req-123 allow-once",
        text: plainText("Allow once"),
      },
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to approve this request.",
      response_type: "ephemeral",
    });
  });

  it("drops block actions when mismatch guard triggers", async () => {
    const { app, getHandler } = setupInteractions({
      shouldDropMismatchedSlackEvent: () => true,
    });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody({ text: "fallback", blocks: [] }, { team: { id: "T9" } }),
      action: {
        type: "button",
        action_id: "openclaw:verify",
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("drops modal lifecycle payloads when mismatch guard triggers", async () => {
    const { getViewHandler, getViewClosedHandler } = setupInteractions({
      shouldDropMismatchedSlackEvent: () => true,
    });

    const viewHandler = getViewHandler();
    const viewClosedHandler = getViewClosedHandler();

    const ackSubmit = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack: ackSubmit,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        view: {
          id: "V123",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({ userId: "U123" }),
        },
      },
    });
    expect(ackSubmit).toHaveBeenCalledTimes(1);

    const ackClosed = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler({
      ack: ackClosed,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        view: {
          id: "V123",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({ userId: "U123" }),
        },
      },
    });
    expect(ackClosed).toHaveBeenCalledTimes(1);
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("does not ack unrelated modal lifecycle payloads", async () => {
    const { getViewHandler } = setupInteractions();
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        view: {
          id: "V123",
          callback_id: "third_party_modal",
        },
      },
    });

    expect(ack).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
  });

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
    const { app, getHandler } = setupInteractions(overrides);
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: actionBody(
        { blocks: [{ type: "actions", block_id: "verify_block", elements: [] }] },
        { userId: senderId, channelId, ts: timestamp, container: false },
      ),
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    if (allowed) {
      expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
      expect(app.client.chat.update).toHaveBeenCalledTimes(1);
      expect(respond).not.toHaveBeenCalled();
      return;
    }
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this control.",
      response_type: "ephemeral",
    });
  });

  it("ignores malformed action payloads after ack and logs warning", async () => {
    const { app, getHandler, runtimeLog } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        { text: "fallback", blocks: singleButtonBlocks("verify_block", "openclaw:verify") },
        { userId: "U666", ts: "777.888", container: false },
      ),
      action: "not-an-action-object" as unknown as Record<string, unknown>,
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledWith(
      "slack:interaction malformed action payload channel=C1 user=U666",
    );
  });

  it("escapes mrkdwn characters in confirmation labels", async () => {
    const { app, getHandler } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        { blocks: [{ type: "actions", block_id: "select_block", elements: [] }] },
        { userId: "U556", ts: "111.223", container: false },
      ),
      action: {
        type: "static_select",
        action_id: "openclaw:pick",
        block_id: "select_block",
        selected_option: {
          text: plainText("Canary_*`~<&>"),
          value: "canary",
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(slackInteractionPayload()).toMatchObject({
      actionType: "static_select",
      selectedValues: ["canary"],
      selectedLabels: ["Canary_*`~<&>"],
    });
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "111.223",
      blocks: [confirmation(":white_check_mark: *Canary_*`~&lt;&amp;&gt;* selected by <@U556>")],
    });
  });

  it("falls back to container channel and message timestamps", async () => {
    const { app, getHandler, resolveSessionKey } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U111" },
        team: { id: "T111" },
        container: { channel_id: "C222", message_ts: "222.333", thread_ts: "222.111" },
      },
      action: {
        type: "button",
        action_id: "openclaw:container",
        block_id: "container_block",
        value: "ok",
        text: plainText("Container"),
      },
    });

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

  it("summarizes multi-select confirmations in updated message rows", async () => {
    const { app, getHandler } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        {
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "multi_block",
              elements: [{ type: "multi_static_select", action_id: "openclaw:multi" }],
            },
          ],
        },
        { userId: "U222", channelId: "C2", ts: "333.444", container: false },
      ),
      action: {
        type: "multi_static_select",
        action_id: "openclaw:multi",
        block_id: "multi_block",
        selected_options: [
          { text: plainText("Alpha"), value: "alpha" },
          { text: plainText("Beta"), value: "beta" },
          { text: plainText("Gamma"), value: "gamma" },
          { text: plainText("Delta"), value: "delta" },
        ],
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expectRecordFields(chatUpdateCall(app), {
      channel: "C2",
      ts: "333.444",
      blocks: [confirmation(":white_check_mark: *Alpha, Beta, Gamma +1* selected by <@U222>")],
    });
  });

  it("renders date/time/datetime picker selections in confirmation rows", async () => {
    const { app, getHandler } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        {
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "date_block",
              elements: [{ type: "datepicker", action_id: "openclaw:date" }],
            },
            {
              type: "actions",
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
            },
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
        { userId: "U333", channelId: "C3", ts: "555.666", container: false },
      ),
      action: {
        type: "datepicker",
        action_id: "openclaw:date",
        block_id: "date_block",
        selected_date: "2026-02-16",
      },
    });

    await handler({
      ack,
      body: actionBody(
        {
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
            },
          ],
        },
        { userId: "U333", channelId: "C3", ts: "555.667", container: false },
      ),
      action: {
        type: "timepicker",
        action_id: "openclaw:time",
        block_id: "time_block",
        selected_time: "14:30",
      },
    });

    await handler({
      ack,
      body: actionBody(
        {
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
        { userId: "U333", channelId: "C3", ts: "555.668", container: false },
      ),
      action: {
        type: "datetimepicker",
        action_id: "openclaw:datetime",
        block_id: "datetime_block",
        selected_date_time: selectedDateTimeEpoch,
      },
    });

    const firstUpdate = chatUpdateCall(app, 0);
    const firstBlocks = firstUpdate.blocks as unknown[];
    expectRecordFields(firstUpdate, { channel: "C3", ts: "555.666" });
    expect(firstBlocks).toHaveLength(3);
    expect(firstBlocks[0]).toEqual(
      confirmation(":white_check_mark: *2026-02-16* selected by <@U333>"),
    );

    expectRecordFields(chatUpdateCall(app, 1), {
      channel: "C3",
      ts: "555.667",
      blocks: [confirmation(":white_check_mark: *14:30* selected by <@U333>")],
    });
    expectRecordFields(chatUpdateCall(app, 2), {
      channel: "C3",
      ts: "555.668",
      blocks: [
        confirmation(
          `:white_check_mark: *${new Date(
            selectedDateTimeEpoch * 1000,
          ).toISOString()}* selected by <@U333>`,
        ),
      ],
    });
  });

  it("captures expanded selection and temporal payload fields", async () => {
    const { getHandler } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody({}, { userId: "U321", channelId: "C2", ts: "222.333", container: false }),
      action: {
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
    });

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

  it("falls back when Slack datetime selection is outside Date range", async () => {
    const { app, getHandler } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        {
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
        { userId: "U333", channelId: "C3", ts: "555.669", container: false },
      ),
      action: {
        type: "datetimepicker",
        action_id: "openclaw:datetime",
        block_id: "datetime_block",
        selected_date_time: 9_000_000_000_000,
      },
    });

    expectRecordFields(chatUpdateCall(app), {
      channel: "C3",
      ts: "555.669",
      blocks: [confirmation(":white_check_mark: *openclaw:datetime* selected by <@U333>")],
    });
  });

  it("captures workflow button trigger metadata", async () => {
    const { getHandler } = setupInteractions();
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        {},
        {
          userId: "U420",
          channelId: "C420",
          ts: "420.420",
          container: false,
          team: { id: "T420" },
        },
      ),
      action: {
        type: "workflow_button",
        action_id: "openclaw:workflow",
        block_id: "workflow_block",
        text: plainText("Launch workflow"),
        workflow: {
          trigger_url: "https://slack.com/workflows/triggers/T420/12345",
          workflow_id: "Wf12345",
        },
      },
    });

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
    const { ctx, getViewHandler, resolveSessionKey } = createContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
    });
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      context: { teamId: "T1" },
      body: {
        user: { id: "U777" },
        team: { id: "T1" },
        view: {
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
                  selected_option: {
                    text: plainText("Production"),
                    value: "prod",
                  },
                },
              },
              notes_block: {
                notes_input: {
                  type: "plain_text_input",
                  value: "ship now",
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777",
      eventScope: expect.objectContaining({ teamId: "T1" }),
    });
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
      sessionKey: "agent:ops:slack:channel:C1",
      deliveryContext: {
        channel: "slack",
        to: "team:T1:user:U777",
        accountId: "default",
      },
    });
    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
      agentId: "ops",
      sessionKey: "agent:ops:slack:channel:C1",
    });
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
    const handleView = getViewClosedHandler();

    await handleView({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: "U777" },
        view: {
          id: "V777",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "C777",
            channelType: "channel",
            userId: "U777",
          }),
        },
      },
    });

    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
      deliveryContext: {
        channel: "slack",
        to: "channel:C777",
        accountId: "default",
      },
    });
    expect(slackInteractionPayload()).toMatchObject({
      interactionType: "view_closed",
      isCleared: false,
    });
  });

  it("reports a failed view_submission follow-up after acknowledging the interaction", async () => {
    enqueueSessionEventMock.mockReturnValue({
      id: "interaction",
      cancel: vi.fn(),
      settled: Promise.resolve({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: "destination replaced",
      }),
    });
    const { getViewHandler, runtimeLog } = setupInteractions();
    const handleView = getViewHandler();

    await handleView({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: "U777" },
        view: {
          id: "V777",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "D777",
            channelType: "im",
            userId: "U777",
          }),
        },
      },
    });

    expect(enqueueSessionEventMock).toHaveBeenCalledOnce();
    expect(runtimeLog).toHaveBeenCalledWith(
      "slack:interaction follow-up failed: destination replaced",
    );
  });

  it("dispatches plugin-owned modal submissions with full view state before compacting events", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
      result: {
        systemEvent: {
          summary: "Contract form stored",
          reference: "contract-submission-123",
        },
      },
    });
    const { ctx, getViewHandler } = setupInteractions();
    const viewHandler = getViewHandler();
    const values: Record<string, Record<string, Record<string, unknown>>> = {};
    for (let index = 0; index < 8; index += 1) {
      values[`field_block_${index}`] = {
        [`field_${index}`]: {
          type: "plain_text_input",
          value: `value-${index}-${"x".repeat(500)}`,
        },
      };
    }

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U777" },
        team: { id: "T1" },
        trigger_id: "trigger-777",
        view: {
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
      },
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
    const eventText = enqueueSessionEventText();
    expect(eventText.length).toBeLessThanOrEqual(2400);
    const payload = slackInteractionPayload();
    expectRecordFields(payload, {
      pluginHandled: true,
      pluginNamespace: "dean.contract",
    });
    expect(payload.pluginSystemEvent).toEqual({
      summary: "Contract form stored",
      reference: "contract-submission-123",
    });
    expect(Array.isArray(payload.inputs) ? payload.inputs.length : 0).toBeLessThanOrEqual(3);
    expect(payload.inputsOmitted).toBe(5);
    expect(payload.payloadTruncated).toBe(true);
  });

  it("dispatches callback-id-only plugin modal submissions without agent routing metadata", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { getViewHandler } = setupInteractions();
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U777" },
        view: {
          id: "V778",
          callback_id: "openclaw:dean.contract:confirm_hearing",
          state: {
            values: {
              contract: {
                name: { type: "plain_text_input", value: "Ari" },
              },
            },
          },
        },
      },
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
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U222" },
        view: {
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
            userId: "U111",
          }),
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("captures modal input labels and picker values across block types", async () => {
    const { getViewHandler } = setupInteractions({ allowFrom: [] });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U444" },
        view: {
          id: "V400",
          callback_id: "openclaw:routing_form",
          private_metadata: JSON.stringify({ userId: "U444" }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: {
                    text: plainText("Production"),
                    value: "prod",
                  },
                },
              },
              assignee_block: {
                assignee_select: {
                  type: "users_select",
                  selected_user: "U900",
                },
              },
              channel_block: {
                channel_select: {
                  type: "channels_select",
                  selected_channel: "C900",
                },
              },
              convo_block: {
                convo_select: {
                  type: "conversations_select",
                  selected_conversation: "G900",
                },
              },
              date_block: {
                date_select: {
                  type: "datepicker",
                  selected_date: "2026-02-16",
                },
              },
              time_block: {
                time_select: {
                  type: "timepicker",
                  selected_time: "12:45",
                },
              },
              datetime_block: {
                datetime_select: {
                  type: "datetimepicker",
                  selected_date_time: 1_771_632_300,
                },
              },
              radio_block: {
                radio_select: {
                  type: "radio_buttons",
                  selected_option: {
                    text: plainText("Blue"),
                    value: "blue",
                  },
                },
              },
              checks_block: {
                checks_select: {
                  type: "checkboxes",
                  selected_options: [
                    { text: plainText("A"), value: "a" },
                    { text: plainText("B"), value: "b" },
                  ],
                },
              },
              number_block: {
                number_input: {
                  type: "number_input",
                  value: "42.5",
                },
              },
              email_block: {
                email_input: {
                  type: "email_text_input",
                  value: "team@openclaw.ai",
                },
              },
              url_block: {
                url_input: {
                  type: "url_text_input",
                  value: "https://docs.openclaw.ai",
                },
              },
              richtext_block: {
                richtext_input: {
                  type: "rich_text_input",
                  rich_text_value: {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [
                          { type: "text", text: "Ship this now" },
                          { type: "text", text: "with canary metrics" },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const payload = slackInteractionPayload();
    const inputs = interactionInputs(payload);
    expectRecordFields(inputByActionId(inputs, "env_select"), {
      selectedValues: ["prod"],
      selectedLabels: ["Production"],
    });
    expectRecordFields(inputByActionId(inputs, "assignee_select"), {
      selectedValues: ["U900"],
      selectedUsers: ["U900"],
    });
    expectRecordFields(inputByActionId(inputs, "channel_select"), {
      selectedValues: ["C900"],
      selectedChannels: ["C900"],
    });
    expectRecordFields(inputByActionId(inputs, "convo_select"), {
      selectedValues: ["G900"],
      selectedConversations: ["G900"],
    });
    expect(inputByActionId(inputs, "date_select").selectedDate).toBe("2026-02-16");
    expect(inputByActionId(inputs, "time_select").selectedTime).toBe("12:45");
    expect(inputByActionId(inputs, "datetime_select").selectedDateTime).toBe(1_771_632_300);
    expectRecordFields(inputByActionId(inputs, "radio_select"), {
      selectedValues: ["blue"],
      selectedLabels: ["Blue"],
    });
    expectRecordFields(inputByActionId(inputs, "checks_select"), {
      selectedValues: ["a", "b"],
      selectedLabels: ["A", "B"],
    });
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
      richTextValue: {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Ship this now" },
              { type: "text", text: "with canary metrics" },
            ],
          },
        ],
      },
    });
  });

  it("captures modal close events and enqueues view closed event", async () => {
    const { ctx, getViewClosedHandler, resolveSessionKey } = createContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });
    const viewClosedHandler = getViewClosedHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler({
      ack,
      body: {
        user: { id: "U900" },
        team: { id: "T1" },
        is_cleared: true,
        view: {
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
                  selected_option: {
                    text: plainText("Canary"),
                    value: "canary",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    const options = requireRecord(
      mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1),
      "enqueueSessionEvent options",
    ) as { sessionKey?: string };
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
    expect(options).toMatchObject({
      deliveryContext: { channel: "slack", accountId: "default" },
    });
    expect(mockCallArg(enqueueSessionEventMock, 0, "enqueueSessionEvent", 1)).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:slack:channel:C99",
    });
  });

  it("keeps block action rich text previews UTF-16 safe at the truncation boundary", async () => {
    const { getHandler } = setupInteractions();
    const handler = getHandler();

    const boundaryText = `${"x".repeat(118)}😀y`;
    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: actionBody(
        {
          text: "fallback",
          blocks: [{ type: "actions", block_id: "richtext_block", elements: [] }],
        },
        { userId: "U555", ts: "111.222", container: false },
      ),
      action: {
        type: "rich_text_input",
        action_id: "openclaw:richtext",
        block_id: "richtext_block",
        rich_text_value: {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: boundaryText }],
            },
          ],
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    const payload = slackInteractionPayload() as { richTextPreview?: string };
    expect(payload.richTextPreview).toBe(`${"x".repeat(118)}…`);
    expect(payload.richTextPreview?.length).toBeLessThanOrEqual(120);
    expect(hasLoneSurrogate(payload.richTextPreview ?? "")).toBe(false);
    expect(() => encodeURIComponent(payload.richTextPreview ?? "")).not.toThrow();
  });
});
const selectedDateTimeEpoch = 1_771_632_300;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
