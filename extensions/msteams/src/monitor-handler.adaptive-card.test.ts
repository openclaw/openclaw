import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { createMSTeamsActivityHandler } from "./monitor-handler.js";
import {
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
    cfg: { channels: { msteams: { dmPolicy: "allowlist", allowFrom: ["user-aad"] } } },
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    accountId: "default",
    appId: "test-app",
    app: {} as MSTeamsMessageHandlerDeps["app"],
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => false),
      findPreferredDmByUserId: vi.fn(async () => null),
    } satisfies MSTeamsConversationStore,
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
}

function cardContext(type: "invoke" | "message", value: unknown): MSTeamsTurnContext {
  return {
    activity: {
      id: `${type}-1`,
      type,
      ...(type === "invoke" ? { name: "adaptiveCard/action" } : { text: "" }),
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: { id: "user-bf", aadObjectId: "user-aad", name: "User" },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: {
        id: type === "invoke" ? "19:personal-chat;messageid=abc123" : "19:personal-chat",
        conversationType: "personal",
      },
      channelData: {},
      attachments: [],
      value,
    },
    sendActivity: vi.fn(async () => ({ id: "activity-id" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext;
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

it("uses account-specific welcome card config", async () => {
  const deps = {
    ...createDeps(),
    accountId: "support",
    cfg: {
      channels: {
        msteams: {
          welcomeCard: true,
          accounts: { support: { welcomeCard: false } },
        },
      },
    } as OpenClawConfig,
  };
  const context: MSTeamsTurnContext = {
    activity: {
      type: "conversationUpdate",
      membersAdded: [{ id: "bot-id" }],
      recipient: { id: "bot-id", name: "Support" },
      conversation: { id: "conversation-id", conversationType: "personal" },
    },
    sendActivity: vi.fn(async () => ({ id: "activity-id" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => undefined),
    deleteActivity: vi.fn(async () => undefined),
  };
  await createMSTeamsActivityHandler(deps)(context);
  expect(context.sendActivity).not.toHaveBeenCalled();
});

describe("msteams adaptive card action invoke", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it.each([
    {
      kind: "imBack",
      activity: "invoke",
      text: "Summarize my last meeting",
      value: {
        action: {
          type: "Action.Submit",
          data: { msteams: { type: "imBack", value: "Summarize my last meeting" } },
        },
      },
    },
    {
      kind: "command",
      activity: "invoke",
      text: "/codex plugins menu",
      value: { action: { type: "Action.Submit", data: "/codex plugins menu" } },
    },
    {
      kind: "message submit",
      activity: "message",
      text: '{"value":"button-submit-value","label":"Submit action"}',
      value: { value: "button-submit-value", label: "Submit action" },
    },
  ] as const)("routes $kind as submitted message text", async ({ kind, activity, text, value }) => {
    await createMSTeamsActivityHandler(createDeps())(cardContext(activity, value));
    expect(lastDispatchedCtxPayload()).toMatchObject({
      BodyForAgent: text,
      CommandBody: text,
      ...(kind === "command"
        ? {}
        : { SessionKey: "msteams:direct:user-aad", SenderId: "user-aad" }),
      ...(kind === "imBack" ? { RawBody: text } : {}),
    });
    if (kind === "imBack") {
      expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves legacy presentation submit values as structured data", async () => {
    const registered = createMSTeamsActivityHandler(createDeps());
    const data = { value: "/codex permissions yolo", label: "Run" };

    await runAdaptiveCardInvoke(registered, {
      action: {
        type: "Action.Submit",
        data,
      },
    });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe(JSON.stringify(data));
    expect(ctxPayload.CommandBody).toBe(JSON.stringify(data));
  });

  it("preserves generic Action.Execute verb metadata", async () => {
    const registered = createMSTeamsActivityHandler(createDeps());
    const payload = {
      action: {
        type: "Action.Execute",
        verb: "ticket.approve",
        data: { ticketId: "ticket-123" },
      },
    };

    await runAdaptiveCardInvoke(registered, payload);

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe(JSON.stringify(payload));
    expect(ctxPayload.CommandBody).toBe(JSON.stringify(payload));
  });

  it.each([
    { activity: "invoke", token: "" },
    { activity: "message", token: "unknown-token" },
  ])(
    "does not dispatch a rejected approval submit from a $activity activity",
    async ({ activity, token }) => {
      const deps = createDeps();
      const data = { openclawAction: "approval", token };
      await createMSTeamsActivityHandler(deps)(
        cardContext(
          activity === "invoke" ? "invoke" : "message",
          activity === "invoke" ? { action: { type: "Action.Submit", data } } : data,
        ),
      );

      expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      expect(deps.log.info).toHaveBeenCalledWith("msteams approval ignored", {
        reason: token ? "unknown or expired card token" : "missing card token",
      });
    },
  );
});
