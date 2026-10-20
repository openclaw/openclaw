import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsReactionHandler } from "./reaction-handler.js";

function buildMockRuntime(production = false): PluginRuntime {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress },
      routing: {
        resolveAgentRoute: production
          ? resolveAgentRoute
          : vi.fn(() => ({
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
      enqueueSystemEvent: production ? enqueueSystemEvent : vi.fn(),
    },
  } as unknown as PluginRuntime;
}

function buildDeps(cfg: OpenClawConfig): MSTeamsMessageHandlerDeps {
  return {
    cfg,
    runtime: { error: vi.fn() } as unknown as MSTeamsMessageHandlerDeps["runtime"],
    accountId: "default",
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

const defaultConfig: OpenClawConfig = {
  channels: { msteams: { allowFrom: ["allowed-aad"], groupPolicy: "open" } },
};
const allowedSender = { id: "u1", aadObjectId: "allowed-aad", name: "User" };
function createReactionTestHarness(cfg = defaultConfig, mockRuntime = buildMockRuntime()) {
  setMSTeamsRuntime(mockRuntime);
  const handler = createMSTeamsReactionHandler(buildDeps(cfg));
  const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;
  const resolveRoute = mockRuntime.channel.routing.resolveAgentRoute as ReturnType<typeof vi.fn>;
  return { handler, enqueue, resolveRoute };
}

async function invokeReactionEvent(
  handler: ReturnType<typeof createMSTeamsReactionHandler>,
  activity: Record<string, unknown>,
  direction: "added" | "removed" = "added",
) {
  await handler(
    {
      activity: {
        type: "messageReaction",
        conversation: { id: "dm-conv", conversationType: "personal" },
        reactionsAdded: [{ type: "like" }],
        from: allowedSender,
        replyToId: "msg-1",
        ...activity,
      },
      sendActivity: vi.fn(async () => undefined),
    } as never,
    direction,
  );
}

describe("createMSTeamsReactionHandler", () => {
  afterEach(resetSystemEventsForTest);

  it("enqueues the exact inbound reaction event label for groupChat conversations", async () => {
    const conversationId = "19:g@thread.v2";
    const { handler, enqueue } = createReactionTestHarness();
    await invokeReactionEvent(handler, {
      conversation: { id: conversationId, conversationType: "groupChat" },
    });

    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      "Teams reaction 👍 added by User on message msg-1",
      {
        sessionKey: "test-session",
        contextKey: `msteams:reaction:${conversationId}:msg-1:allowed-aad:like:added`,
      },
    );
  });

  it.each([
    { name: "empty reactions", activity: { reactionsAdded: [], replyToId: "msg-3" } },
    { name: "missing sender ID", activity: { from: {}, replyToId: "msg-4" } },
    {
      name: "non-allowlisted DM sender",
      activity: {
        from: { id: "bad-user", aadObjectId: "not-allowed", name: "Attacker" },
        replyToId: "msg-5",
      },
    },
  ])("skips $name", async ({ activity }) => {
    const { handler, enqueue } = createReactionTestHarness();
    await invokeReactionEvent(handler, activity);
    expect(enqueue).not.toHaveBeenCalled();
  });
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

  function reactionFrom(conversation: Record<string, unknown>, teamId: string) {
    return {
      reactionsAdded: [{ type: "like" }],
      from: { id: "teams-user", aadObjectId: "allowed-aad", name: "Allowed Sender" },
      conversation,
      channelData: { team: { id: teamId } },
      replyToId: "target-message",
    };
  }
  function expectedEvent(direction: "added" | "removed", exactLabel = false) {
    return expect.objectContaining({
      text: exactLabel
        ? "Teams reaction 👍 added by Allowed Sender on message target-message"
        : expect.stringContaining("target-message"),
      contextKey: `msteams:reaction:19:trusted-channel@thread.tacv2:target-message:allowed-aad:like:${direction}`,
    });
  }

  it("drops a removed reaction from a team/channel outside the configured allowlist", async () => {
    const { handler, enqueue } = createReactionTestHarness(routeCfg);
    const reaction = reactionFrom(
      { id: "19:excluded-channel@thread.tacv2", conversationType: "channel" },
      "excludedTeam",
    );
    await invokeReactionEvent(
      handler,
      { ...reaction, reactionsAdded: undefined, reactionsRemoved: [{ type: "like" }] },
      "removed",
    );

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("drops a personal reaction with contradictory channel metadata", async () => {
    const { handler, enqueue, resolveRoute } = createReactionTestHarness(routeCfg);
    await invokeReactionEvent(
      handler,
      {
        from: { id: "teams-user", aadObjectId: "allowed-aad", name: "Allowed Sender" },
        conversation: { id: "19:excluded-channel@thread.tacv2", conversationType: "personal" },
        channelData: { channel: { id: "19:excluded-channel@thread.tacv2" } },
        replyToId: "target-message",
      },
      "added",
    );

    expect(resolveRoute).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enforces reaction admission at the production route and session-event queue", async () => {
    const { handler } = createReactionTestHarness(routeCfg, buildMockRuntime(true));
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

    await invokeReactionEvent(handler, reactionFrom(allowedConversation, "trustedTeam"));

    expect(peekSystemEventEntries(allowedRoute.sessionKey)).toEqual([expectedEvent("added", true)]);

    resetSystemEventsForTest();
    const threadId = "1700000000000";
    const threadedReaction = reactionFrom(
      { ...allowedConversation, id: `${allowedConversation.id};messageid=${threadId}` },
      "trustedTeam",
    );
    await invokeReactionEvent(handler, threadedReaction);
    await invokeReactionEvent(
      handler,
      {
        ...threadedReaction,
        reactionsAdded: undefined,
        reactionsRemoved: [{ type: "like" }],
      },
      "removed",
    );

    expect(peekSystemEventEntries(`${allowedRoute.sessionKey}:thread:${threadId}`)).toEqual([
      expectedEvent("added"),
      expectedEvent("removed"),
    ]);
    expect(peekSystemEventEntries(allowedRoute.sessionKey)).toEqual([]);

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
  it("allows reaction from static access group DM sender", async () => {
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
    };
    const { handler, enqueue } = createReactionTestHarness(cfg);

    await invokeReactionEvent(handler, {
      from: { id: "good-user", aadObjectId: "allowed-aad", name: "Alice" },
      replyToId: "msg-7",
    });

    expect(enqueue).toHaveBeenCalledOnce();
  });
});
