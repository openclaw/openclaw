import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { createMessageHandlerDeps, createTurnContext } from "./message-handler.test-support.js";
import { createMSTeamsReactionHandler } from "./reaction-handler.js";

const channelId = "19:trusted-channel@thread.tacv2";
const cfg: OpenClawConfig = {
  channels: {
    msteams: {
      dmPolicy: "allowlist",
      allowFrom: ["allowed-aad"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["allowed-aad"],
      teams: { trustedTeam: { channels: { [channelId]: {} } } },
    },
  },
};
type Activity = Partial<MSTeamsTurnContext["activity"]>;
function setup(config = cfg) {
  const { deps } = createMessageHandlerDeps(config);
  const route = vi.fn(resolveAgentRoute);
  const enqueue = vi.fn(enqueueSystemEvent);
  Object.assign(getMSTeamsRuntime().channel.routing, { resolveAgentRoute: route });
  Object.assign(getMSTeamsRuntime().system, { enqueueSystemEvent: enqueue });
  const handler = createMSTeamsReactionHandler(deps);
  return {
    route,
    enqueue,
    send: (activity: Activity, direction: "added" | "removed" = "added") =>
      handler(
        createTurnContext({
          type: "messageReaction",
          from: { id: "user", aadObjectId: "allowed-aad", name: "User" },
          conversation: { id: "dm", conversationType: "personal" },
          replyToId: "target",
          reactionsAdded: [{ type: "like" }],
          ...activity,
        }),
        direction,
      ),
  };
}

describe("Teams reaction admission and routing", () => {
  afterEach(resetSystemEventsForTest);
  it.each<[string, Activity, "added" | "removed"]>([
    ["empty reactions", { reactionsAdded: [] }, "added"],
    ["missing sender", { from: {} }, "added"],
    ["unlisted sender", { from: { id: "attacker" } }, "added"],
    [
      "unlisted channel",
      {
        conversation: { id: "excluded", conversationType: "channel" },
        channelData: { team: { id: "excluded" } },
        reactionsRemoved: [{ type: "like" }],
      },
      "removed",
    ],
    ["contradictory channel metadata", { channelData: { channel: { id: channelId } } }, "added"],
    [
      "contradictory group metadata",
      {
        conversation: { id: "excluded", conversationType: "personal", isGroup: true },
        channelData: { team: { id: "excluded" } },
      },
      "added",
    ],
  ])("drops %s before routing or queueing", async (_name, activity, direction) => {
    const { send, route, enqueue } = setup();
    await send(activity, direction);
    expect(route).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["groupChat", "channel", "thread"])(
    "queues %s reactions on the production session",
    async (kind) => {
      const group = kind === "groupChat";
      const config = group ? { channels: { msteams: { groupPolicy: "open" as const } } } : cfg;
      const conversationId = group ? "19:group@thread.v2" : channelId;
      const base = resolveAgentRoute({
        cfg: config,
        channel: "msteams",
        peer: {
          kind: group ? "group" : "channel",
          id: conversationId,
        },
        ...(group ? {} : { teamId: "trustedTeam" }),
      }).sessionKey;
      const thread = kind === "thread";
      const sessionKey = thread ? `${base}:thread:root` : base;
      const { send } = setup(config);
      const activity = {
        conversation: {
          id: thread ? `${conversationId};messageid=root` : conversationId,
          conversationType: group ? "groupChat" : "channel",
        },
        ...(group ? {} : { channelData: { team: { id: "trustedTeam" } } }),
      };
      await send(activity);
      const expected = (direction: "added" | "removed") =>
        expect.objectContaining({
          text:
            direction === "added"
              ? "Teams reaction 👍 added by User on message target"
              : "Teams reaction 👍 removed by User from message target",
          contextKey: `msteams:reaction:${conversationId}:target:allowed-aad:like:${direction}`,
        });
      if (thread) {
        await send({ ...activity, reactionsRemoved: [{ type: "like" }] }, "removed");
        expect(peekSystemEventEntries(base)).toEqual([]);
      }
      expect(peekSystemEventEntries(sessionKey)).toEqual(
        thread ? [expected("added"), expected("removed")] : [expected("added")],
      );
    },
  );

  it("admits a static access-group DM sender", async () => {
    const { send, enqueue } = setup({
      accessGroups: {
        operators: { type: "message.senders", members: { msteams: ["allowed-aad"] } },
      },
      channels: { msteams: { dmPolicy: "allowlist", allowFrom: ["accessGroup:operators"] } },
    });
    await send({});
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
