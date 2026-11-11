import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const BASE_SESSION_KEY = "agent:main:mattermost:direct:user-1";

type ThreadCase = {
  label: string;
  channelType: "D" | "O";
  replyToMode: "off" | "first";
  postId: string;
  threadRootId?: string;
  interactionPost?: boolean;
  sessionKey: string;
  replyToId: string | undefined;
};

function createMonitor(params: Pick<ThreadCase, "channelType" | "replyToMode">) {
  const core = createPluginRuntimeMock();
  core.channel.routing.resolveAgentRoute = () => ({
    channel: "mattermost",
    matchedBy: "default",
    accountId: "default",
    agentId: "main",
    lastRoutePolicy: "main",
    mainSessionKey: BASE_SESSION_KEY,
    sessionKey: BASE_SESSION_KEY,
  });
  const cfg = {
    channels: {
      mattermost: {
        enabled: true,
        baseUrl: "http://127.0.0.1:9",
        botToken: "mattermost-event-plan-token",
        replyToModeByChatType: { direct: params.replyToMode, channel: params.replyToMode },
      },
    },
  };
  return {
    account: resolveMattermostAccount({ cfg }),
    cfg,
    core,
    resources: {
      resolveChannelInfo: async () => ({ id: "chan-1", type: params.channelType }),
    },
    logVerboseMessage: () => {},
    logDebugMessage: () => {},
  } as unknown as MattermostMonitorContext;
}

describe("buildMattermostEventPlan thread session", () => {
  it.each<ThreadCase>([
    // A user's own top-level post still opens a thread session under reply mode first.
    {
      label: "user top-level DM post opens its own thread",
      channelType: "D",
      replyToMode: "first",
      postId: "post-1",
      sessionKey: `${BASE_SESSION_KEY}:thread:post-1`,
      replyToId: "post-1",
    },
    // Interactive posts are UI containers, never conversation roots: a picker or question
    // card posted at the DM root must stay on the root session the command ran in.
    {
      label: "root-level interactive post stays on the DM session",
      channelType: "D",
      replyToMode: "first",
      postId: "picker-1",
      interactionPost: true,
      sessionKey: BASE_SESSION_KEY,
      replyToId: undefined,
    },
    {
      label: "interactive post inside a thread keeps that thread",
      channelType: "D",
      replyToMode: "first",
      postId: "picker-2",
      threadRootId: "root-1",
      interactionPost: true,
      sessionKey: `${BASE_SESSION_KEY}:thread:root-1`,
      replyToId: "root-1",
    },
    {
      label: "flat DM (reply mode off) is unchanged",
      channelType: "D",
      replyToMode: "off",
      postId: "picker-3",
      interactionPost: true,
      sessionKey: BASE_SESSION_KEY,
      replyToId: undefined,
    },
    {
      label: "root-level interactive post in a channel stays on the channel session",
      channelType: "O",
      replyToMode: "first",
      postId: "picker-4",
      interactionPost: true,
      sessionKey: BASE_SESSION_KEY,
      replyToId: undefined,
    },
  ])(
    "$label",
    async ({ channelType, replyToMode, postId, threadRootId, interactionPost, ...expected }) => {
      const plan = await buildMattermostEventPlan(createMonitor({ channelType, replyToMode }), {
        channelId: "chan-1",
        senderId: "user-1",
        postId,
        threadRootId,
        interactionPost,
        dropLabel: "test event",
      });
      expect(plan?.thread).toMatchObject({
        sessionKey: expected.sessionKey,
        effectiveReplyToId: expected.replyToId,
      });
    },
  );
});
