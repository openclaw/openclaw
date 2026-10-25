import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { createMessageHandlerDeps, createTurnContext } from "./message-handler.test-support.js";
import { createMSTeamsReactionHandler } from "./reaction-handler.js";

const defaultConfig: OpenClawConfig = {
  channels: { msteams: { allowFrom: ["allowed-aad"], groupPolicy: "open" } },
};
const allowedSender = { id: "u1", aadObjectId: "allowed-aad", name: "User" };
function createReactionTestHarness(cfg = defaultConfig, production = false) {
  const resolveRoute = vi.fn(() => ({
    sessionKey: "test-session",
    agentId: "agent1",
    accountId: "default",
  }));
  const fixture = createMessageHandlerDeps(cfg, { resolveAgentRoute: resolveRoute });
  if (production) {
    const runtime = getMSTeamsRuntime();
    runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
    runtime.system.enqueueSystemEvent = enqueueSystemEvent;
  }
  return {
    handler: createMSTeamsReactionHandler(fixture.deps),
    enqueue: fixture.enqueueSystemEvent,
    resolveRoute,
  };
}

async function invokeReactionEvent(
  handler: ReturnType<typeof createMSTeamsReactionHandler>,
  activity: Record<string, unknown>,
  direction: "added" | "removed" = "added",
) {
  await handler(
    createTurnContext({
      type: "messageReaction",
      conversation: { id: "dm-conv", conversationType: "personal" },
      reactionsAdded: [{ type: "like" }],
      from: allowedSender,
      replyToId: "msg-1",
      ...activity,
    }),
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

  it.each<[string, Record<string, unknown>, "added" | "removed"]>([
    ["empty reactions", { reactionsAdded: [] }, "added"],
    ["missing sender ID", { from: {} }, "added"],
    [
      "non-allowlisted DM sender",
      { from: { id: "bad-user", aadObjectId: "not-allowed" } },
      "added",
    ],
    [
      "unlisted team/channel",
      {
        ...reactionFrom(
          { id: "19:excluded-channel@thread.tacv2", conversationType: "channel" },
          "excludedTeam",
        ),
        reactionsAdded: undefined,
        reactionsRemoved: [{ type: "like" }],
      },
      "removed",
    ],
    [
      "contradictory channel metadata",
      {
        conversation: { id: "19:excluded-channel@thread.tacv2", conversationType: "personal" },
        channelData: { channel: { id: "19:excluded-channel@thread.tacv2" } },
      },
      "added",
    ],
  ])("skips %s before routing", async (_name, activity, direction) => {
    const { handler, enqueue, resolveRoute } = createReactionTestHarness(routeCfg);
    await invokeReactionEvent(handler, activity, direction);
    expect(resolveRoute).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enforces reaction admission at the production route and session-event queue", async () => {
    const { handler } = createReactionTestHarness(routeCfg, true);
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
    const { handler, enqueue } = createReactionTestHarness({
      accessGroups: {
        operators: { type: "message.senders", members: { msteams: ["allowed-aad"] } },
      },
      channels: { msteams: { dmPolicy: "allowlist", allowFrom: ["accessGroup:operators"] } },
    });
    await invokeReactionEvent(handler, {});
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
