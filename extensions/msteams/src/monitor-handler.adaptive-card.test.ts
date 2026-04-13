import {
  ACTION_APPROVAL_INTERACTIVE_DATA_KEY,
  ACTION_APPROVAL_SCHEMA_VERSION,
  buildActionApprovalInteractiveData,
} from "openclaw/plugin-sdk/action-approval-runtime";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const runtimeApiMockState = vi.hoisted(() => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(async (params: { ctxPayload: unknown }) => ({
    queuedFinal: false,
    counts: {},
    capturedCtxPayload: params.ctxPayload,
  })),
}));

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
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
  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: vi.fn() },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: <T>(params: {
          onFlush: (entries: T[]) => Promise<void>;
        }): { enqueue: (entry: T) => Promise<void> } => ({
          enqueue: async (entry: T) => {
            await params.onFlush([entry]);
          },
        }),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
      text: {
        hasControlCommand: () => false,
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
          accountId: "default",
        }),
      },
      reply: {
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
      },
      session: {
        recordInboundSession: vi.fn(async () => undefined),
      },
    },
  } as unknown as PluginRuntime);

  return {
    cfg: {} as OpenClawConfig,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore: {
      upsert: vi.fn(async () => undefined),
    } as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
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

  let handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  handler = {
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
    clearPluginInteractiveHandlers();
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
    expect(
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0],
    ).toMatchObject({
      ctxPayload: {
        RawBody: JSON.stringify(payload),
        BodyForAgent: JSON.stringify(payload),
        CommandBody: JSON.stringify(payload),
        SessionKey: "msteams:direct:user-aad",
        SenderId: "user-aad",
      },
    });
  });

  it("dispatches registered plugin interactive handlers before the generic fallback", async () => {
    const deps = createDeps();
    const interactiveHandler = vi.fn(async () => ({ handled: true }));
    const interactiveData = buildActionApprovalInteractiveData({
      namespace: "m365.approval",
      payload: {
        version: ACTION_APPROVAL_SCHEMA_VERSION,
        ownerSessionKey: "agent:main:main",
        flowId: "flow-1",
        expectedRevision: 2,
        snapshotHash: "abc123",
        decision: "approve",
        action: {
          kind: "mail.reply",
          title: "Reply to thread",
          highRisk: true,
        },
      },
    });
    registerPluginInteractiveHandler("m365", {
      channel: "msteams",
      namespace: "m365.approval",
      handler: interactiveHandler,
    });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await registered.run({
      activity: {
        id: "invoke-2",
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
        value: {
          action: {
            type: "Action.Submit",
            data: {
              [ACTION_APPROVAL_INTERACTIVE_DATA_KEY]: interactiveData,
              decision: "approve",
            },
          },
        },
      },
      sendActivity: vi.fn(async () => ({ id: "activity-id" })),
      sendActivities: async () => [],
      updateActivity: vi.fn(async () => ({ id: "updated" })),
      deleteActivity: vi.fn(async () => undefined),
    } as unknown as MSTeamsTurnContext);

    expect(interactiveHandler).toHaveBeenCalledTimes(1);
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).not.toHaveBeenCalled();
  });

  it("does not intercept non-reserved adaptive card payloads before the generic fallback", async () => {
    const deps = createDeps();
    const interactiveHandler = vi.fn(async () => ({ handled: true }));
    registerPluginInteractiveHandler("m365", {
      channel: "msteams",
      namespace: "m365.approval",
      handler: interactiveHandler,
    });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await registered.run({
      activity: {
        id: "invoke-3",
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
        value: {
          data: "m365.approval:opaque-payload",
        },
      },
      sendActivity: vi.fn(async () => ({ id: "activity-id" })),
      sendActivities: async () => [],
      updateActivity: vi.fn(async () => ({ id: "updated" })),
      deleteActivity: vi.fn(async () => undefined),
    } as unknown as MSTeamsTurnContext);

    expect(interactiveHandler).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
  });
});
