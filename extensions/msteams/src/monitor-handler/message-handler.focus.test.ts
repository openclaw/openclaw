import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/msteams";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMSTeamsChannelFocusStorePath } from "../channel-focus-store.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

const focusMockState = vi.hoisted(() => ({
  dispatchReply: vi.fn(async () => ({ queuedFinal: false, counts: { final: 0 } })),
}));

vi.mock("openclaw/plugin-sdk/msteams", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/msteams")>(
    "openclaw/plugin-sdk/msteams",
  );
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher: focusMockState.dispatchReply,
  };
});

describe("msteams message handler channel focus", () => {
  const recordInboundSession = vi.fn(async () => undefined);
  const updateLastRoute = vi.fn(async () => undefined);
  const conversationStore = {
    upsert: vi.fn(async () => undefined),
  };
  let tempDir: string;
  let sessionStorePath: string;

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
    focusMockState.dispatchReply.mockClear();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "msteams-focus-"));
    sessionStorePath = path.join(tempDir, "sessions.json");
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
          resolveStorePath: () => sessionStorePath,
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
    expect(updateLastRoute).not.toHaveBeenCalled();

    const usedStorePath = recordInboundSession.mock.calls[0]?.[0]?.storePath as string;

    const focusStore = JSON.parse(
      fs.readFileSync(resolveMSTeamsChannelFocusStorePath(usedStorePath), "utf8"),
    ) as {
      focusByMainSessionKey?: Record<
        string,
        { label?: string; target?: string; teamLabel?: string; channelLabel?: string }
      >;
    };
    expect(focusStore.focusByMainSessionKey?.["agent:main:main"]).toMatchObject({
      target: "conversation:19:channel@thread.tacv2",
      label: "Team One / #General",
      teamLabel: "Team One",
      channelLabel: "#General",
    });
  });

  it("injects recent channel focus into repeated DM turns from sidecar metadata", async () => {
    fs.writeFileSync(
      resolveMSTeamsChannelFocusStorePath(sessionStorePath),
      JSON.stringify(
        {
          version: 1,
          focusByMainSessionKey: {
            "agent:main:main": {
              provider: "msteams",
              target: "conversation:19:channel@thread.tacv2",
              label: "Team One / #General",
              teamLabel: "Team One",
              channelLabel: "#General",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      ),
    );
    const handler = createMSTeamsMessageHandler(createDeps());

    const dmActivity = {
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
    } as unknown as Parameters<typeof handler>[0];

    await handler(dmActivity);
    await handler({
      ...dmActivity,
      activity: {
        ...dmActivity.activity,
        id: "msg-dm-2",
        text: "and do you still know which channel?",
      },
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(2);
    for (const call of recordInboundSession.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          ctx: expect.objectContaining({
            UntrustedContext: expect.arrayContaining([
              "Recent Microsoft Teams channel focus: Team One / #General.",
              "If the user explicitly asks you to post back to that channel, use target conversation:19:channel@thread.tacv2.",
            ]),
          }),
        }),
      );
    }
  });
});
