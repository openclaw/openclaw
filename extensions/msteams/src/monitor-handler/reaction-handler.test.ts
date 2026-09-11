// Msteams tests cover reaction handler plugin behavior.
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsReactionHandler } from "./reaction-handler.js";

function buildMockRuntime(overrides?: Partial<PluginRuntime>): PluginRuntime {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "test-session",
          agentId: "agent1",
          accountId: "default",
        })),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    ...overrides,
  } as unknown as PluginRuntime;
}

function buildProductionBoundaryRuntime(): PluginRuntime {
  const runtime = buildMockRuntime();
  return {
    ...runtime,
    channel: {
      ...runtime.channel,
      routing: { ...runtime.channel.routing, resolveAgentRoute },
    },
    system: { ...runtime.system, enqueueSystemEvent },
  };
}

function buildDeps(cfg: OpenClawConfig, _runtime?: PluginRuntime): MSTeamsMessageHandlerDeps {
  return {
    cfg,
    runtime: { error: vi.fn() } as unknown as MSTeamsMessageHandlerDeps["runtime"],
    appId: "test-app",
    app: {} as MSTeamsMessageHandlerDeps["app"],
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
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
      warn: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };
}

function createReactionTestHarness() {
  const mockRuntime = buildMockRuntime();
  setMSTeamsRuntime(mockRuntime);

  const cfg: OpenClawConfig = {
    channels: { msteams: { allowFrom: ["allowed-aad"], groupPolicy: "open" } },
  } as OpenClawConfig;

  const deps = buildDeps(cfg, mockRuntime);
  const handler = createMSTeamsReactionHandler(deps);
  const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;

  return { handler, enqueue };
}

function firstEnqueueCall(enqueue: ReturnType<typeof vi.fn>): unknown[] {
  const [call] = enqueue.mock.calls;
  if (!call) {
    throw new Error("Expected enqueueSystemEvent call");
  }
  return call;
}

function firstEnqueueLabel(enqueue: ReturnType<typeof vi.fn>): string {
  const [label] = firstEnqueueCall(enqueue);
  if (typeof label !== "string") {
    throw new Error("Expected enqueueSystemEvent label");
  }
  return label;
}

async function invokeReactionEvent(
  handler: ReturnType<typeof createMSTeamsReactionHandler>,
  activity: Record<string, unknown>,
  direction: "added" | "removed",
) {
  await handler(
    {
      activity: {
        type: "messageReaction",
        conversation: { id: "dm-conv", conversationType: "personal" },
        ...activity,
      },
      sendActivity: vi.fn(async () => undefined),
    } as never,
    direction,
  );
}

describe("createMSTeamsReactionHandler", () => {
  afterEach(() => {
    resetSystemEventsForTest();
  });

  describe("emoji mapping", () => {
    it("maps Teams reaction types to unicode emoji in event label", async () => {
      const mockRuntime = buildMockRuntime();
      setMSTeamsRuntime(mockRuntime);

      const cfg: OpenClawConfig = {
        channels: {
          msteams: {
            allowFrom: ["allowed-aad"],
          },
        },
      } as OpenClawConfig;

      const deps = buildDeps(cfg);
      const handler = createMSTeamsReactionHandler(deps);

      await handler(
        {
          activity: {
            type: "messageReaction",
            reactionsAdded: [{ type: "like" }],
            from: { id: "user-id", aadObjectId: "allowed-aad", name: "Alice" },
            conversation: { id: "personal-conv", conversationType: "personal" },
            replyToId: "msg-123",
          },
          sendActivity: vi.fn(async () => undefined),
        } as never,
        "added",
      );

      const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;
      expect(enqueue).toHaveBeenCalledOnce();
      const label = firstEnqueueLabel(enqueue);
      expect(label).toContain("👍");
      expect(label).toContain("Alice");
      expect(label).toContain("msg-123");
    });

    it("maps heart, laugh, surprised, sad, angry reaction types", async () => {
      const emojiMap: Record<string, string> = {
        heart: "❤️",
        laugh: "😆",
        surprised: "😮",
        sad: "😢",
        angry: "😡",
      };

      for (const [type, expectedEmoji] of Object.entries(emojiMap)) {
        const mockRuntime = buildMockRuntime();
        setMSTeamsRuntime(mockRuntime);

        const cfg: OpenClawConfig = {
          channels: { msteams: { allowFrom: ["allowed-aad"] } },
        } as OpenClawConfig;

        const deps = buildDeps(cfg, mockRuntime);
        const handler = createMSTeamsReactionHandler(deps);

        await handler(
          {
            activity: {
              type: "messageReaction",
              reactionsAdded: [{ type }],
              from: { id: "user-id", aadObjectId: "allowed-aad", name: "Bob" },
              conversation: { id: "dm-conv", conversationType: "personal" },
              replyToId: "msg-456",
            },
            sendActivity: vi.fn(async () => undefined),
          } as never,
          "added",
        );

        const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;
        const label = firstEnqueueLabel(enqueue);
        expect(label).toContain(expectedEmoji);
      }
    });
  });

  describe("inbound reaction events", () => {
    it.each([
      { conversationType: "personal", conversationId: "a:dm" },
      { conversationType: "groupChat", conversationId: "19:g@thread.v2" },
      { conversationType: "channel", conversationId: "19:c@thread.tacv2" },
    ] as const)(
      "enqueues the exact inbound reaction event label for $conversationType conversations",
      async ({ conversationType, conversationId }) => {
        const { handler, enqueue } = createReactionTestHarness();
        await invokeReactionEvent(
          handler,
          {
            reactionsAdded: [{ type: "like" }],
            from: { id: "u1", aadObjectId: "allowed-aad", name: "User" },
            conversation: { id: conversationId, conversationType },
            replyToId: "msg-1",
          },
          "added",
        );

        expect(enqueue).toHaveBeenCalledExactlyOnceWith(
          "Teams reaction 👍 added by User on message msg-1",
          {
            sessionKey: "test-session",
            contextKey: `msteams:reaction:${conversationId}:msg-1:allowed-aad:like:added`,
          },
        );
      },
    );

    it("enqueues system event for reactionsRemoved", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsRemoved: [{ type: "heart" }],
          from: { id: "u1", aadObjectId: "allowed-aad", name: "User" },
          replyToId: "msg-2",
        },
        "removed",
      );

      expect(enqueue).toHaveBeenCalledOnce();
      const label = firstEnqueueLabel(enqueue);
      expect(label).toContain("removed");
      expect(label).toContain("❤️");
    });

    it("skips when reactions array is empty", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [],
          from: { id: "u1", aadObjectId: "allowed-aad", name: "User" },
          replyToId: "msg-3",
        },
        "added",
      );

      expect(enqueue).not.toHaveBeenCalled();
    });

    it("skips when from.id is missing", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: {},
          replyToId: "msg-4",
        },
        "added",
      );

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe("team/channel route authorization", () => {
    const routeCfg = {
      channels: {
        msteams: {
          dmPolicy: "allowlist",
          allowFrom: ["allowed-aad"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["allowed-aad"],
          teams: { trustedTeam: { channels: { "19:trusted-channel@thread.tacv2": {} } } },
        },
      },
    } as OpenClawConfig;

    function createRouteHarness() {
      const mockRuntime = buildMockRuntime();
      setMSTeamsRuntime(mockRuntime);
      const handler = createMSTeamsReactionHandler(buildDeps(routeCfg, mockRuntime));
      return {
        handler,
        enqueue: mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>,
        resolveAgentRoute: mockRuntime.channel.routing.resolveAgentRoute as ReturnType<
          typeof vi.fn
        >,
      };
    }

    function reactionFrom(conversation: Record<string, unknown>, teamId: string) {
      return {
        reactionsAdded: [{ type: "like" }],
        from: { id: "teams-user", aadObjectId: "allowed-aad", name: "Allowed Sender" },
        conversation,
        channelData: { team: { id: teamId } },
        replyToId: "target-message",
      };
    }

    it.each(["added", "removed"] as const)(
      "drops a %s reaction from a team/channel outside the configured allowlist",
      async (direction) => {
        const { handler, enqueue } = createRouteHarness();
        const reaction = reactionFrom(
          { id: "19:excluded-channel@thread.tacv2", conversationType: "channel" },
          "excludedTeam",
        );
        await invokeReactionEvent(
          handler,
          direction === "added"
            ? reaction
            : { ...reaction, reactionsAdded: undefined, reactionsRemoved: [{ type: "like" }] },
          direction,
        );

        expect(enqueue).not.toHaveBeenCalled();
      },
    );

    it("enqueues a reaction from an allowlisted team/channel", async () => {
      const { handler, enqueue } = createRouteHarness();
      await invokeReactionEvent(
        handler,
        reactionFrom(
          { id: "19:trusted-channel@thread.tacv2", conversationType: "channel" },
          "trustedTeam",
        ),
        "added",
      );

      expect(enqueue).toHaveBeenCalledOnce();
    });

    it.each([
      {
        scopeMarker: "isGroup",
        conversation: {
          id: "19:excluded-channel@thread.tacv2",
          conversationType: "personal",
          isGroup: true,
        },
        channelData: undefined,
      },
      {
        scopeMarker: "team metadata",
        conversation: { id: "19:excluded-channel@thread.tacv2", conversationType: "personal" },
        channelData: { team: { id: "excludedTeam" } },
      },
      {
        scopeMarker: "channel metadata",
        conversation: { id: "19:excluded-channel@thread.tacv2", conversationType: "personal" },
        channelData: { channel: { id: "19:excluded-channel@thread.tacv2" } },
      },
    ])("drops a personal reaction with contradictory $scopeMarker", async (activityScope) => {
      const { handler, enqueue, resolveAgentRoute: resolveRouteMock } = createRouteHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: { id: "teams-user", aadObjectId: "allowed-aad", name: "Allowed Sender" },
          conversation: activityScope.conversation,
          channelData: activityScope.channelData,
          replyToId: "target-message",
        },
        "added",
      );

      expect(resolveRouteMock).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("enforces reaction admission at the production route and session-event queue", async () => {
      const runtime = buildProductionBoundaryRuntime();
      setMSTeamsRuntime(runtime);
      const handler = createMSTeamsReactionHandler(buildDeps(routeCfg, runtime));
      const allowedConversation = {
        id: "19:trusted-channel@thread.tacv2",
        conversationType: "channel",
      };
      const allowedRoute = resolveAgentRoute({
        cfg: routeCfg,
        channel: "msteams",
        peer: { kind: "channel", id: allowedConversation.id },
        teamId: "trustedTeam",
      });

      await invokeReactionEvent(handler, reactionFrom(allowedConversation, "trustedTeam"), "added");

      expect(peekSystemEventEntries(allowedRoute.sessionKey)).toEqual([
        expect.objectContaining({
          text: "Teams reaction 👍 added by Allowed Sender on message target-message",
          contextKey:
            "msteams:reaction:19:trusted-channel@thread.tacv2:target-message:allowed-aad:like:added",
        }),
      ]);

      resetSystemEventsForTest();
      const forbiddenDirectRoute = resolveAgentRoute({
        cfg: routeCfg,
        channel: "msteams",
        peer: { kind: "direct", id: "allowed-aad" },
      });
      await invokeReactionEvent(
        handler,
        reactionFrom(
          {
            id: "19:excluded-channel@thread.tacv2",
            conversationType: "personal",
            isGroup: true,
          },
          "excludedTeam",
        ),
        "added",
      );

      expect(peekSystemEventEntries(forbiddenDirectRoute.sessionKey)).toEqual([]);
    });
  });

  describe("sender authorization", () => {
    it("drops reaction from non-allowlisted DM sender", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: { id: "bad-user", aadObjectId: "not-allowed", name: "Attacker" },
          replyToId: "msg-5",
        },
        "added",
      );

      expect(enqueue).not.toHaveBeenCalled();
    });

    it("allows reaction from allowlisted DM sender", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: { id: "good-user", aadObjectId: "allowed-aad", name: "Alice" },
          replyToId: "msg-6",
        },
        "added",
      );

      expect(enqueue).toHaveBeenCalledOnce();
    });

    it("allows reaction from static access group DM sender", async () => {
      const mockRuntime = buildMockRuntime();
      setMSTeamsRuntime(mockRuntime);
      const cfg: OpenClawConfig = {
        accessGroups: {
          operators: {
            type: "message.senders",
            members: { msteams: ["allowed-aad"] },
          },
        },
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["accessGroup:operators"],
          },
        },
      } as OpenClawConfig;
      const handler = createMSTeamsReactionHandler(buildDeps(cfg, mockRuntime));
      const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;

      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: { id: "good-user", aadObjectId: "allowed-aad", name: "Alice" },
          replyToId: "msg-7",
        },
        "added",
      );

      expect(enqueue).toHaveBeenCalledOnce();
    });
  });
});
