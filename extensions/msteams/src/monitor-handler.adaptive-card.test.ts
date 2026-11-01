import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsActivityHandler } from "./monitor-handler.js";
import {
  createMSTeamsMessageHandlerDeps,
  getMSTeamsTestRuntimeState,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const runtimeApiMockState = getMSTeamsTestRuntimeState();

vi.mock("./reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
  }),
}));

function createDeps(): MSTeamsMessageHandlerDeps {
  installMSTeamsTestRuntime();

  return {
    ...createMSTeamsMessageHandlerDeps({
      cfg: { channels: { msteams: { dmPolicy: "allowlist", allowFrom: ["user-aad"] } } },
    }),
    appId: "test-app",
    mediaMaxBytes: 1024 * 1024,
  };
}

function messageContext(value: unknown, invoke: boolean) {
  return {
    activity: {
      id: invoke ? "invoke-1" : "message-1",
      type: invoke ? "invoke" : "message",
      ...(invoke ? { name: "adaptiveCard/action" } : { text: "" }),
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: "user-bf",
        aadObjectId: "user-aad",
        name: "User",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: invoke ? "19:personal-chat;messageid=abc123" : "19:personal-chat",
        conversationType: "personal",
      },
      channelData: {},
      attachments: [],
      value,
    },
    sendActivity: vi.fn(async () => ({ id: "activity-id" })),
  } as unknown as MSTeamsTurnContext;
}

async function runAdaptiveCardInvoke(value: unknown) {
  await createMSTeamsActivityHandler(createDeps())(messageContext(value, true));
}

async function welcome(
  deps: MSTeamsMessageHandlerDeps,
  conversationType = "personal",
  name?: string,
) {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  await createMSTeamsActivityHandler(deps)({
    activity: {
      type: "conversationUpdate",
      membersAdded: [{ id: "bot-id" }],
      recipient: { id: "bot-id", name },
      conversation: { id: "conversation-id", conversationType },
    },
    sendActivity,
    updateActivity: vi.fn(async () => undefined),
  });
  return sendActivity;
}

function lastDispatchedCtxPayload(): Record<string, unknown> {
  const dispatched = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock.calls.at(
    -1,
  )?.[0] as { ctx?: Record<string, unknown> } | undefined;
  if (!dispatched?.ctx) {
    throw new Error("expected dispatched context payload");
  }
  return dispatched.ctx;
}

describe("msteams members added handler", () => {
  it.each([
    { promptStarters: ["Do X", "Do Y"], labels: ["Do X", "Do Y"] },
    {
      promptStarters: [],
      labels: ["What can you do?", "Summarize my last meeting", "Help me draft an email"],
    },
  ])("sends welcome card starters $promptStarters", async ({ promptStarters, labels }) => {
    const deps = createDeps();
    deps.cfg = { channels: { msteams: { promptStarters } } };
    const sendActivity = await welcome(deps);
    expect(sendActivity).toHaveBeenCalledWith({
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.5",
            body: [
              { type: "TextBlock", text: "Hi! I'm OpenClaw.", weight: "Bolder", size: "Medium" },
              {
                type: "TextBlock",
                text: "I can help you with questions, tasks, and more. Here are some things to try:",
                wrap: true,
              },
            ],
            actions: labels.map((label) => ({
              type: "Action.Submit",
              title: label,
              data: { msteams: { type: "imBack", value: label } },
            })),
          },
        },
      ],
    });
  });

  it.each([
    { botName: undefined, name: "OpenClaw" },
    { botName: "", name: "OpenClaw" },
    { botName: "Support", name: "Support" },
  ])("sends the group welcome for $botName", async ({ botName, name }) => {
    const deps = createDeps();
    deps.cfg = { channels: { msteams: { groupWelcomeCard: true } } };
    const sendActivity = await welcome(deps, "groupChat", botName);
    expect(sendActivity).toHaveBeenCalledWith(
      `Hi! I'm ${name}. Mention me with @${name} to get started.`,
    );
  });

  it("uses account-specific welcome card config", async () => {
    const deps: MSTeamsMessageHandlerDeps = {
      ...createDeps(),
      accountId: "support",
      cfg: {
        channels: {
          msteams: {
            welcomeCard: true,
            accounts: {
              support: {
                appId: "support-app",
                welcomeCard: false,
              },
            },
          },
        },
      },
    };
    expect(await welcome(deps, "personal", "Support")).not.toHaveBeenCalled();
  });
});

describe("msteams adaptive card action invoke", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("routes Teams imBack actions as the submitted message text", async () => {
    await runAdaptiveCardInvoke({
      action: {
        type: "Action.Submit",
        data: { msteams: { type: "imBack", value: "Summarize my last meeting" } },
      },
    });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(ctxPayload).toMatchObject({
      RawBody: "Summarize my last meeting",
      SessionKey: "msteams:direct:user-aad",
      SenderId: "user-aad",
      BodyForAgent: "Summarize my last meeting",
      CommandBody: "Summarize my last meeting",
    });
  });

  it.each([
    {
      label: "typed command",
      action: { type: "Action.Submit", data: "/codex plugins menu" },
      text: "/codex plugins menu",
    },
    {
      label: "legacy structured data",
      action: { type: "Action.Submit", data: { value: "/codex permissions yolo", label: "Run" } },
      text: JSON.stringify({ value: "/codex permissions yolo", label: "Run" }),
    },
    {
      label: "execute metadata",
      action: { type: "Action.Execute", verb: "ticket.approve", data: { ticketId: "ticket-123" } },
      text: '{"action":{"type":"Action.Execute","verb":"ticket.approve","data":{"ticketId":"ticket-123"}}}',
    },
  ])("preserves $label", async ({ action, text }) => {
    await runAdaptiveCardInvoke({ action });
    expect(lastDispatchedCtxPayload()).toMatchObject({ BodyForAgent: text, CommandBody: text });
  });

  it.each([
    { activity: "invoke", token: "" },
    { activity: "message", token: "unknown-token" },
  ])(
    "does not dispatch a rejected approval submit from a $activity activity",
    async ({ activity, token }) => {
      const deps = createDeps();
      const data = { openclawAction: "approval", ...(token !== undefined ? { token } : {}) };
      await createMSTeamsActivityHandler(deps)(
        messageContext(
          activity === "invoke" ? { action: { type: "Action.Submit", data } } : data,
          activity === "invoke",
        ),
      );

      expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      expect(deps.log.info).toHaveBeenCalledWith("msteams approval ignored", {
        reason: token ? "unknown or expired card token" : "missing card token",
      });
    },
  );

  it("routes message activities with submitted card values as message text", async () => {
    const data = { value: "button-submit-value", label: "Submit action" };

    await createMSTeamsActivityHandler(createDeps())(messageContext(data, false));

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe(JSON.stringify(data));
    expect(ctxPayload.CommandBody).toBe(JSON.stringify(data));
    expect(ctxPayload.SessionKey).toBe("msteams:direct:user-aad");
    expect(ctxPayload.SenderId).toBe("user-aad");
  });
});
