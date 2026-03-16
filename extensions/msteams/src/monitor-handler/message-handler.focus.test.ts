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

const graphMockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(async () => "graph-token"),
  getTeamById: vi.fn<(...args: unknown[]) => Promise<{ id?: string; displayName?: string } | null>>(
    async () => null,
  ),
  listChannelsForTeam: vi.fn<
    (...args: unknown[]) => Promise<Array<{ id?: string; displayName?: string }>>
  >(async () => []),
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

vi.mock("../graph.js", async () => {
  const actual = await vi.importActual<typeof import("../graph.js")>("../graph.js");
  return {
    ...actual,
    resolveGraphToken: graphMockState.resolveGraphToken,
    getTeamById: graphMockState.getTeamById,
    listChannelsForTeam: graphMockState.listChannelsForTeam,
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
    graphMockState.resolveGraphToken.mockClear();
    graphMockState.getTeamById.mockClear();
    graphMockState.listChannelsForTeam.mockClear();
    graphMockState.resolveGraphToken.mockResolvedValue("graph-token");
    graphMockState.getTeamById.mockResolvedValue(null);
    graphMockState.listChannelsForTeam.mockResolvedValue([]);
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

    const firstInboundCall = recordInboundSession.mock.calls as unknown as Array<
      [
        {
          storePath: string;
          ctx: Record<string, unknown>;
        },
      ]
    >;
    const usedStorePath = firstInboundCall[0][0].storePath;

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
      resolution: {
        teamLabelSource: "activity",
        channelLabelSource: "activity",
        graphAttempted: false,
      },
    });
  });

  it("uses graph-resolved names when inbound activity omits readable labels", async () => {
    graphMockState.getTeamById.mockResolvedValue({
      id: "team-guid-1",
      displayName: "Project Ops",
    });
    graphMockState.listChannelsForTeam.mockResolvedValue([
      { id: "19:channel@thread.tacv2", displayName: "Release Alerts" },
    ]);

    const handler = createMSTeamsMessageHandler(
      createDeps({
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["sender-aad"],
            teams: {
              "team-guid-1": {
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
        id: "msg-channel-graph",
        type: "message",
        text: "hello graph names",
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
          tenantId: "tenant-1",
        },
        channelData: {
          team: { id: "runtime-team-id", aadGroupId: "team-guid-1" },
          channel: { id: "19:channel@thread.tacv2" },
        },
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    const firstInboundCall = recordInboundSession.mock.calls as unknown as Array<
      [
        {
          storePath: string;
          ctx: Record<string, unknown>;
        },
      ]
    >;
    const usedStorePath = firstInboundCall[0][0].storePath;
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
      label: "Project Ops / #Release Alerts",
      teamLabel: "Project Ops",
      channelLabel: "#Release Alerts",
      resolution: {
        teamLabelSource: "graph",
        channelLabelSource: "graph",
        graphAttempted: true,
        graphTeamLookup: "hit",
        graphChannelLookup: "hit",
      },
    });
    expect(conversationStore.upsert).toHaveBeenLastCalledWith(
      "19:channel@thread.tacv2",
      expect.objectContaining({
        teamName: "Project Ops",
        channelName: "Release Alerts",
        graphTeamId: "team-guid-1",
        teamRuntimeId: "runtime-team-id",
      }),
    );
  });

  it("injects recent channel focus into repeated DM turns from sidecar metadata", async () => {
    const focusPayload = JSON.stringify(
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
    );
    const defaultSessionStorePath = path.join(
      process.env.HOME ?? os.homedir(),
      ".openclaw",
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    for (const targetStorePath of [sessionStorePath, defaultSessionStorePath]) {
      const focusPath = resolveMSTeamsChannelFocusStorePath(targetStorePath);
      fs.mkdirSync(path.dirname(focusPath), { recursive: true });
      fs.writeFileSync(focusPath, focusPayload);
    }
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
    for (const call of recordInboundSession.mock.calls as unknown as Array<
      [
        {
          storePath: string;
          ctx: Record<string, unknown>;
        },
      ]
    >) {
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
