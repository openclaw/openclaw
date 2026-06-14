// Msteams tests cover monitor handler.adaptive card plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import { installMSTeamsTestRuntime } from "./monitor-handler.test-helpers.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const runtimeApiMockState = vi.hoisted(() => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(async (params: { ctxPayload: unknown }) => ({
    queuedFinal: false,
    counts: {},
    capturedCtxPayload: params.ctxPayload,
  })),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher:
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher,
  };
});

vi.mock("./reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcher: {},
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }),
}));

function createDeps(): MSTeamsMessageHandlerDeps {
  installMSTeamsTestRuntime();

  return {
    cfg: {} as OpenClawConfig,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    app: {} as MSTeamsMessageHandlerDeps["app"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => false),
      findPreferredDmByUserId: vi.fn(async () => null),
      findByUserId: vi.fn(async () => null),
    } satisfies MSTeamsConversationStore,
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };
}

function createActivityHandler() {
  const messageHandlers: Array<(context: unknown, next: () => Promise<void>) => Promise<void>> = [];
  const run = vi.fn(async (context: unknown) => {
    const activityType = (context as MSTeamsTurnContext).activity?.type;
    if (activityType !== "message") {
      return;
    }
    for (const handler of messageHandlers) {
      await handler(context, async () => {});
    }
  });
  const handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  } = {
    onMessage: (nextHandler) => {
      messageHandlers.push(nextHandler);
      return handler;
    },
    onMembersAdded: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };

  return { handler, run };
}

describe("msteams adaptive card action invoke", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
  });

  it("forwards adaptive card invoke values to the agent as message text", async () => {
    const deps = createDeps();
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const payload = {
      action: {
        type: "Action.Submit",
        data: {
          intent: "deploy",
          environment: "prod",
        },
      },
      trigger: "button-click",
    };

    await registered.run({
      activity: {
        id: "invoke-1",
        type: "invoke",
        name: "adaptiveCard/action",
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
          id: "19:personal-chat;messageid=abc123",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
        value: payload,
      },
      sendActivity: vi.fn(async () => ({ id: "activity-id" })),
      sendActivities: async () => [],
    } as unknown as MSTeamsTurnContext);

    expect(run).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    const dispatched = runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock
      .calls[0]?.[0] as { ctxPayload?: Record<string, unknown> } | undefined;
    expect(dispatched?.ctxPayload?.RawBody).toBe(JSON.stringify(payload));
    expect(dispatched?.ctxPayload?.BodyForAgent).toBe(JSON.stringify(payload));
    expect(dispatched?.ctxPayload?.CommandBody).toBe(JSON.stringify(payload));
    expect(dispatched?.ctxPayload?.SessionKey).toBe("msteams:direct:user-aad");
    expect(dispatched?.ctxPayload?.SenderId).toBe("user-aad");
  });

  it("message action in a group chat dispatches despite mention-gating (B8)", async () => {
    // "Ask OpenClaw about this" produces a synthetic message with no @mention. In a group chat
    // (requireMention defaults true) the dispatch was silently mention-gated right after the
    // "On it" ack — the reply never came. The invoke wrapper now stamps a bot-mention entity.
    const deps = createDeps();
    deps.cfg = {
      channels: { msteams: { groupPolicy: "open" } },
    } as unknown as OpenClawConfig;
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await registered.run({
      activity: {
        id: "invoke-2",
        type: "invoke",
        name: "composeExtension/submitAction",
        channelId: "msteams",
        serviceUrl: "https://service.example.test",
        from: { id: "user-bf", aadObjectId: "user-aad", name: "User" },
        recipient: { id: "bot-id", name: "Bot" },
        conversation: { id: "19:group-chat-id@thread.v2", conversationType: "groupChat" },
        channelData: {},
        attachments: [],
        value: {
          commandId: "askOpenClaw",
          messagePayload: {
            body: { content: "please review the Q3 numbers", contentType: "text" },
            from: { user: { displayName: "Sara" } },
          },
        },
      },
      sendActivity: vi.fn(async () => ({ id: "activity-id" })),
      sendActivities: async () => [],
    } as unknown as MSTeamsTurnContext);

    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    const dispatched = runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock
      .calls[0]?.[0] as { ctxPayload?: Record<string, unknown> } | undefined;
    expect(String(dispatched?.ctxPayload?.BodyForAgent)).toContain("please review the Q3 numbers");
  });
});
