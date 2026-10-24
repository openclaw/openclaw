import { expectDefined } from "@openclaw/normalization-core";
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
  enqueueSessionEventMock: enqueueEvent,
  ack,
  respond,
  readSlackMessagesMock: readMessages,
  dispatchPluginInteractiveHandlerMock: dispatchPlugin,
  resolvePluginConversationBindingApprovalMock: resolveBinding,
  resolveApprovalOverGatewayMock: resolveApproval,
  resolveQuestionOverGatewayMock: resolveQuestion,
} = getSlackInteractionMocks();
function pluginDispatchCall(index = 0) {
  return expectDefined(dispatchPlugin.mock.calls[index]?.[0], "plugin dispatch");
}
function slackInteractionPayload(callIndex = 0): Record<string, unknown> {
  return JSON.parse(enqueueSystemEventText(callIndex).replace("Slack interaction: ", ""));
}
function eventOptions() {
  return expectDefined(enqueueEvent.mock.calls[0]?.[1], "event options");
}
function enqueueSystemEventText(callIndex = 0) {
  return expectDefined(enqueueEvent.mock.calls[callIndex]?.[0], "event text");
}
function expectUpdated(
  app: ReturnType<typeof createContext>["app"],
  expected: Record<string, unknown>,
) {
  expect(app.client.chat.update).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "C1", ts: "100.200", ...expected }),
  );
}
function expectInput(actionId: string, expected: Record<string, unknown>) {
  expect(slackInteractionPayload().inputs).toEqual(
    expect.arrayContaining([expect.objectContaining({ actionId, ...expected })]),
  );
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
type ViewBody = Parameters<
  ReturnType<ReturnType<typeof createContext>["getViewHandler"]>
>[0]["body"];
function viewBody(
  view: NonNullable<ViewBody["view"]>,
  userId: string,
  extra: Omit<ViewBody, "view" | "user"> = {},
) {
  return { user: { id: userId }, view, ...extra };
}
function modalBody(
  userId: string,
  metadata: Record<string, unknown>,
  view: Parameters<typeof viewBody>[0] = {},
  extra: Parameters<typeof viewBody>[2] = {},
) {
  return {
    user: { id: userId },
    view: {
      callback_id: "openclaw:deploy_form",
      private_metadata: JSON.stringify({ userId, ...metadata }),
      ...view,
    },
    ...extra,
  };
}
function approvalButton(value: string, blockId = "exec_actions", label = "Allow once") {
  return button("openclaw:approval_button:1:1", blockId, value, label);
}
function expectPrivateReply(text: string) {
  expect(respond).toHaveBeenCalledWith({ text, response_type: "ephemeral" });
}
function expectApproval(cfg: unknown, overrides: Record<string, unknown> = {}) {
  expect(resolveApproval).toHaveBeenCalledWith({
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
  readMessages.mockResolvedValueOnce({
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
describe("registerSlackInteractionEvents", () => {
  it.each([false, true])("routes shortcuts (selected message: %s)", async (message) => {
    const { ctx, getShortcutHandler, resolveSessionKey } = interactionContext({
      installationIdentity: { kind: "enterprise", enterpriseId: "E1" },
      resolveChannelName: async () => ({ name: "ops", type: "channel" }),
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
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
      triggerId: "[redacted]",
      ...(message
        ? {
            threadTs: "200.100",
            messageUserId: "U456",
            messageText: "Selected message",
            responseUrl: "[redacted]",
          }
        : {}),
    });
    expect(enqueueSystemEventText()).not.toContain("secret");
    expect(eventOptions()).toMatchObject({
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
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("enforces DM policy for global shortcuts", async () => {
    const { getShortcutHandler } = setupInteractions({ dmEnabled: false, dmPolicy: "disabled" });
    await getShortcutHandler()({ ack, body: shortcutBody() });
    expect(enqueueEvent).not.toHaveBeenCalled();
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
    dispatchPlugin.mockResolvedValueOnce(pluginHandled);
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
    const { app, click } = setupInteractions();
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
        blocks: singleButtonBlocks("reply_actions", "openclaw:reply_button"),
      },
    );
    expect(dispatchPlugin).not.toHaveBeenCalled();
    const eventText = enqueueSystemEventText();
    expect(eventText).toContain('"actionId":"openclaw:reply_button"');
    expect(eventOptions()).toMatchObject({
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
    dispatchPlugin.mockResolvedValue(pluginHandled);
    const { click } = setupInteractions();
    await click(button("openclaw:callback_button:1:1", "choice", "/approve req-1 deny", "Choose"));
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(pluginDispatchCall().data).toBe("/approve req-1 deny");
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("uses unique interaction ids for repeated Slack actions on the same message", async () => {
    dispatchPlugin.mockResolvedValue({
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
    resolveBinding.mockResolvedValueOnce(approvedPluginBindingResult());
    const { app, click } = setupInteractions();
    await click(
      button("openclaw:reply_button", "bind_actions", "pluginbind:approval-123:o", "Allow once"),
      buttonMessage("bind_actions", "openclaw:reply_button", "Approve this bind?"),
      {
        threadTs: "100.100",
      },
      { respond },
    );
    expect(resolveBinding).toHaveBeenCalledWith({
      approvalId: "approval-123",
      decision: "allow-once",
      senderId: "U123",
    });
    expect(dispatchPlugin).not.toHaveBeenCalled();
    expectUpdated(app, {
      text: "Approve this bind?",
      blocks: [],
    });
    expectPrivateReply("Binding updated.");
    expect(enqueueEvent).not.toHaveBeenCalled();
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
      resolveApproval.mockResolvedValueOnce({
        applied: false,
        approval: { status: "denied", decision: "deny", presentation: { kind: "exec" } },
      });
    } else if (outcome === "expired") {
      resolveApproval.mockRejectedValueOnce(new Error("unknown or expired approval id"));
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
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(dispatchPlugin).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();
    if (outcome === "malformed" || outcome === "unauthorized") {
      expect(resolveApproval).not.toHaveBeenCalled();
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
  it.each(["enterprise", "workspace"] as const)(
    "scopes plugin reviewers on %s installs",
    async (kind) => {
      const approver = "team:T11111111:user:U123OWNER";
      const pluginPolicy = {
        allowFrom: [approver],
        execApprovals: { enabled: "auto", target: "dm" },
      };
      const { ctx, click } = interactionContext({
        installationIdentity:
          kind === "enterprise" ? { kind, enterpriseId: "E1" } : { kind, teamId: "T11111111" },
        cfg:
          kind === "enterprise"
            ? { channels: { slack: { accounts: { default: pluginPolicy } } } }
            : {
                approvals: { plugin: { slack: { approvers: [approver] } } },
                channels: { slack: { allowFrom: ["U999LEGACY"] } },
              },
      });
      if (kind === "workspace") {
        Object.assign(ctx, { teamId: "T11111111" });
      }
      registerSlackInteractionEvents({ ctx: ctx as never });
      currentMessage(approvalButtonBlocks("req-123", "plugin", "allow-once"));
      for (const teamId of kind === "enterprise" ? ["T11111111", "T22222222"] : ["T11111111"]) {
        await click(
          approvalButton(
            'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-once"}',
          ),
          {},
          { userId: "U123OWNER", channelId: "C11111111", team: { id: teamId } },
          { respond, context: { teamId } },
        );
      }
      expect(resolveApproval).toHaveBeenCalledOnce();
      expectApproval(ctx.cfg, { approvalKind: "plugin", senderId: approver });
      if (kind === "enterprise") {
        expect(readMessages).toHaveBeenCalledOnce();
        expectPrivateReply("You are not authorized to approve this request.");
      }
    },
  );
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
    expect(resolveQuestion).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      questionId,
      optionIndex: 1,
      senderId: "U123",
      clientDisplayName: "Slack question (default)",
    });
    expectPrivateReply("Answer submitted.");
    expect(enqueueEvent).not.toHaveBeenCalled();
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
        resolveApproval.mockRejectedValueOnce(new Error("unknown or expired approval id"));
      } else if (scenario === "gateway-down") {
        resolveApproval.mockRejectedValueOnce(new Error("gateway down"));
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
      expect(enqueueEvent).not.toHaveBeenCalled();
      expect(dispatchPlugin).not.toHaveBeenCalled();
      expect(resolveBinding).not.toHaveBeenCalled();
      if (denied) {
        expect(resolveApproval).not.toHaveBeenCalled();
        expectPrivateReply("You are not authorized to approve this request.");
      } else {
        expect(resolveApproval).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            approvalId,
            decision,
            senderId: sender,
            resolveMethod: "exec",
          }),
        );
        if (fallback) {
          expect(resolveApproval).toHaveBeenNthCalledWith(
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
  it.each([
    ["mismatch", "openclaw:verify", undefined],
    ["malformed", "openclaw:verify", undefined],
    ["link", "openclaw:reply_link:1:1", undefined],
    ["link", "openclaw:session_link:1", undefined],
    ["link", "openclaw:reply_button:1:1", "/approve req-1 allow-once"],
    ["plugin", "openclaw:session_linked", undefined],
  ] as const)("handles %s action %s", async (mode, actionId, value) => {
    const { app, click, runtimeLog } = setupInteractions({
      shouldDropMismatchedSlackEvent: () => mode === "mismatch",
    });
    const action =
      mode === "malformed"
        ? ("not-an-action-object" as unknown as Record<string, unknown>)
        : {
            ...button(actionId, "reply_actions", value ?? "", "Launch"),
            url: "https://example.com/app",
          };
    await click(action, buttonMessage("reply_actions", actionId), {}, { respond });
    expect(ack).toHaveBeenCalledOnce();
    expect(resolveApproval).not.toHaveBeenCalled();
    if (mode === "plugin") {
      expect(dispatchPlugin).toHaveBeenCalled();
    } else {
      expect(dispatchPlugin).not.toHaveBeenCalled();
      expect(enqueueEvent).not.toHaveBeenCalled();
      expect(app.client.chat.update).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    }
    if (mode === "malformed") {
      expect(runtimeLog).toHaveBeenCalledWith(
        "slack:interaction malformed action payload channel=C1 user=U123",
      );
    }
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
      expect(enqueueEvent).not.toHaveBeenCalled();
      expect(dispatchPlugin).not.toHaveBeenCalled();
    },
  );
  const owner = { allowFrom: ["U_OWNER"] };
  const channelUsers = { C1: { users: ["U_ALLOWED"] } };
  it.each([
    ["global deny", owner, "U_ATTACKER", "C1", false],
    ["channel allow", { ...owner, channelsConfig: channelUsers }, "U_ALLOWED", "C1", true],
    [
      "wildcard deny",
      { allowFrom: ["*"], channelsConfig: channelUsers },
      "U_ATTACKER",
      "C1",
      false,
    ],
    ["open allow", { allowFrom: [] }, "U_ANYONE", "C1", true],
    ["DM deny", { ...owner, dmPolicy: "allowlist" }, "U_ATTACKER", "D222", false],
    ["MPIM deny", mpimPolicy(), "U_ATTACKER", "G_MPIM", false],
    ["MPIM allow", mpimPolicy(), "U_OWNER", "G_MPIM", true],
  ] satisfies Array<
    [string, NonNullable<Parameters<typeof createContext>[0]>, string, string, boolean]
  >)("%s", async (_name, overrides, senderId, channelId, allowed) => {
    const { app, click } = setupInteractions(overrides);
    await click(
      { type: "button", action_id: "openclaw:verify", block_id: "verify_block" },
      { blocks: [actions("verify_block", [])] },
      { userId: senderId, channelId, ts: "250.251", container: false },
      { respond },
    );
    if (allowed) {
      expect(enqueueEvent).toHaveBeenCalledTimes(1);
      expect(app.client.chat.update).toHaveBeenCalledTimes(1);
      expect(respond).not.toHaveBeenCalled();
      return;
    }
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expectPrivateReply("You are not authorized to use this control.");
  });
  const rich = richText("Ship this now", "with canary metrics");
  it.each([
    [
      "static_select",
      { selected_option: option("Canary_*`~<&>", "canary") },
      "Canary_*`~&lt;&amp;&gt;",
    ],
    [
      "multi_static_select",
      {
        selected_options: ["Alpha", "Beta", "Gamma", "Delta"].map((v) =>
          option(v, v.toLowerCase()),
        ),
      },
      "Alpha, Beta, Gamma +1",
    ],
    ["datepicker", { selected_date: "2026-02-16" }, "2026-02-16"],
    ["timepicker", { selected_time: "14:30" }, "14:30"],
    [
      "datetimepicker",
      { selected_date_time: 1_771_632_300 },
      new Date(1_771_632_300 * 1000).toISOString(),
    ],
    ["datetimepicker", { selected_date_time: 9_000_000_000_000 }, "openclaw:pick"],
    [
      "multi_conversations_select",
      {
        selected_user: "U777",
        selected_users: ["U777", "U888"],
        selected_channel: "C777",
        selected_channels: ["C777", "C888"],
        selected_conversation: "G777",
        selected_conversations: ["G777", "G888"],
        selected_options: [
          option("Alpha", "alpha"),
          option("Alpha", "alpha"),
          option("Beta", "beta"),
        ],
        selected_date: "2026-02-16",
        selected_time: "14:30",
        selected_date_time: 1_771_700_200,
      },
      "Alpha, Beta",
      {
        selectedValues: ["alpha", "beta", "U777", "U888", "C777", "C888", "G777", "G888"],
        selectedUsers: ["U777", "U888"],
        selectedChannels: ["C777", "C888"],
        selectedConversations: ["G777", "G888"],
        selectedLabels: ["Alpha", "Beta"],
        selectedDate: "2026-02-16",
        selectedTime: "14:30",
        selectedDateTime: 1_771_700_200,
      },
    ],
    [
      "workflow_button",
      {
        workflow: {
          trigger_url: "https://slack.com/workflows/triggers/T420/12345",
          workflow_id: "Wf12345",
        },
      },
      "openclaw:pick",
      { workflowTriggerUrl: "[redacted]", workflowId: "Wf12345" },
    ],
    ["number_input", { value: "42.5" }, "42.5", { inputKind: "number", inputNumber: 42.5 }],
    [
      "email_text_input",
      { value: "team@openclaw.ai" },
      "team@openclaw.ai",
      { inputKind: "email", inputEmail: "team@openclaw.ai" },
    ],
    [
      "url_text_input",
      { value: "https://docs.openclaw.ai" },
      "https://docs.openclaw.ai",
      { inputKind: "url", inputUrl: "https://docs.openclaw.ai/" },
    ],
    [
      "rich_text_input",
      { rich_text_value: rich },
      "Ship this now with canary metrics",
      {
        inputKind: "rich_text",
        richTextPreview: "Ship this now with canary metrics",
        richTextValue: rich,
      },
    ],
  ] satisfies Array<[string, Record<string, unknown>, string, Record<string, unknown>?]>)(
    "renders %s confirmation",
    async (type, selection, label, summary) => {
      const { app, click } = setupInteractions();
      const untouched = [
        actions("time", [{ type: "timepicker", action_id: "openclaw:time" }]),
        actions("datetime", [{ type: "datetimepicker", action_id: "openclaw:datetime" }]),
      ];
      const selectedControl = { type, action_id: "openclaw:pick" };
      await click(
        { ...selectedControl, block_id: "select", ...selection },
        {
          blocks: [
            actions("select", type === "static_select" ? [] : [selectedControl]),
            ...untouched,
          ],
        },
      );
      if (type === "static_select") {
        expect(slackInteractionPayload()).toMatchObject({
          selectedValues: ["canary"],
          selectedLabels: ["Canary_*`~<&>"],
        });
      }
      if (summary) {
        expect(slackInteractionPayload()).toMatchObject(summary);
      }
      expectUpdated(app, {
        blocks: [
          confirmation(":white_check_mark: *" + label + "* selected by <@U123>"),
          ...untouched,
        ],
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
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    const payload = slackInteractionPayload();
    expect(payload).toMatchObject({
      channelId: "C222",
      messageTs: "222.333",
      threadTs: "222.111",
      teamId: "T111",
    });
    expect(app.client.chat.update).not.toHaveBeenCalled();
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
            previous_view_id: "VPREV",
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
        viewHash: "[redacted]",
        isStackedView: true,
        privateMetadata: "[redacted]",
        ...(!submission ? { isCleared: recorded } : {}),
      });
      expectInput("env_select", { selectedValues: ["prod"] });
      expectInput("notes_input", { inputValue: "ship now" });
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
    dispatchPlugin.mockResolvedValueOnce({
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
      ),
    });
    const call = pluginDispatchCall();
    expect(call.data).toBe("dean.contract:confirm_hearing");
    expect(call.conversation).toMatchObject({ conversationId: "user:U777" });
    expect(call.ctx.auth.isAuthorizedSender).toBe(true);
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
    expect(payload.inputs).toHaveLength(3);
  });
  it("dispatches callback-id-only plugin modal submissions without agent routing metadata", async () => {
    dispatchPlugin.mockResolvedValueOnce(pluginHandled);
    const { getViewHandler } = setupInteractions();
    await getViewHandler()({
      ack,
      body: viewBody(
        {
          id: "V778",
          callback_id: "openclaw:dean.contract:confirm_hearing",
        },
        "U777",
      ),
    });
    const call = pluginDispatchCall();
    expect(call.data).toBe("dean.contract:confirm_hearing");
    expect(call.dedupeId).toBe("view_submission:openclaw:dean.contract:confirm_hearing:V778:U777");
    expect(call.ctx.auth.isAuthorizedSender).toBe(false);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("blocks modal events when private metadata userId does not match submitter", async () => {
    const { getViewHandler } = setupInteractions();
    await getViewHandler()({
      ack,
      body: modalBody("U222", { channelId: "D123", channelType: "im", userId: "U111" }),
    });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
