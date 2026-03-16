import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/msteams";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

const focusMockState = vi.hoisted(() => ({
  loadSessionStore: vi.fn(() => ({})),
  dispatchReply: vi.fn(async () => ({ queuedFinal: false, counts: { final: 0 } })),
}));

vi.mock("openclaw/plugin-sdk/msteams", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/msteams")>(
    "openclaw/plugin-sdk/msteams",
  );
  return {
    ...actual,
    loadSessionStore: focusMockState.loadSessionStore,
    dispatchReplyFromConfigWithSettledDispatcher: focusMockState.dispatchReply,
  };
});

describe("msteams message handler channel focus", () => {
  const recordInboundSession = vi.fn(async () => undefined);
  const updateLastRoute = vi.fn(async () => undefined);
  const conversationStore = {
    upsert: vi.fn(async () => undefined),
  };

  function createDeps(cfg: OpenClawConfig = {} as OpenClawConfig): MSTeamsMessageHandlerDeps {
    return {
      cfg,
      runtime: { error: vi.fn() } as unknown as RuntimeEnv,
      appId: "test-app",
      adapter: {
        continueConversation: vi.fn(async () => undefined),
      } as unknown as MSTeamsMessageHandlerDeps["adapter"],
      tokenProvider: {
        getAccessToken: vi.fn(async () => "token"),
      },
      textLimit: 4000,
      mediaMaxBytes: 1024 * 1024,
      conversationStore:
        conversationStore as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
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

  beforeEach(() => {
    recordInboundSession.mockClear();
    updateLastRoute.mockClear();
    conversationStore.upsert.mockClear();
    focusMockState.loadSessionStore.mockReset();
    focusMockState.loadSessionStore.mockReturnValue({});
    focusMockState.dispatchReply.mockClear();
    setMSTeamsRuntime({
      logging: {
        shouldLogVerbose: () => false,
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: <T>(params: { onFlush: (entries: T[]) => Promise<void> }) => ({
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
          resolveChunkMode: () => "paragraph",
          resolveMarkdownTableMode: () => "native",
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:msteams:route",
            mainSessionKey: "agent:main:main",
          }),
        },
        reply: {
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ({
            ...ctx,
            CommandAuthorized: ctx.CommandAuthorized === true,
          }),
          createReplyDispatcherWithTyping: () => ({
            dispatcher: vi.fn(),
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          }),
          resolveHumanDelayConfig: () => undefined,
        },
        session: {
          resolveStorePath: () => "/tmp/sessions.json",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession,
          updateLastRoute,
        },
      },
    } as unknown as PluginRuntime);
  });

  it("stores recent channel focus on the main session without changing DM route", async () => {
    const handler = createMSTeamsMessageHandler(
      createDeps({
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["sender-aad"],
            teams: {
              "team-1": {
                channels: {
                  "19:channel@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig),
    );

    await handler({
      activity: {
        id: "msg-channel-1",
        type: "message",
        text: "hello team",
        from: {
          id: "sender-id",
          aadObjectId: "sender-aad",
          name: "Sender",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:channel@thread.tacv2",
          conversationType: "channel",
        },
        channelData: {
          team: { id: "team-1", name: "Team One" },
          channel: { id: "chan-1", name: "General" },
        },
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalled();
    expect(updateLastRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: expect.any(String),
        sessionKey: "agent:main:main",
        ctx: expect.objectContaining({
          ChatType: "channel",
          GroupChannel: "#General",
          GroupSpace: "Team One",
          GroupSubject: "Team One",
          OriginatingTo: "conversation:19:channel@thread.tacv2",
        }),
      }),
    );
    expect(updateLastRoute.mock.calls[0]?.[0]).not.toHaveProperty("deliveryContext");
  });

  it("injects recent channel focus into DM turns as untrusted metadata", async () => {
    focusMockState.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
        channel: "msteams",
        chatType: "channel",
        groupChannel: "#General",
        space: "Team One",
        origin: {
          provider: "msteams",
          chatType: "channel",
          to: "conversation:19:channel@thread.tacv2",
          label: "Team One / #General",
        },
      },
    });
    const handler = createMSTeamsMessageHandler(createDeps());

    await handler({
      activity: {
        id: "msg-dm-1",
        type: "message",
        text: "post that update please",
        from: {
          id: "sender-id",
          aadObjectId: "sender-aad",
          name: "Sender",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:dm@unq.gbl.spaces",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          UntrustedContext: expect.arrayContaining([
            "Recent Microsoft Teams channel focus: Team One / #General.",
            "If the user explicitly asks you to post back to that channel, use target conversation:19:channel@thread.tacv2.",
          ]),
        }),
      }),
    );
  });
});
