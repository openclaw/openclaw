import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../../runtime-api.js";
import { reactMessageMSTeams } from "../graph-messages.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
  createTurnContext,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;

vi.mock("../graph-messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../graph-messages.js")>()),
  reactMessageMSTeams: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../graph-thread.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../graph-thread.js")>()),
  fetchChannelMessage: vi.fn(async () => undefined),
  fetchThreadReplies: vi.fn(async () => []),
  fetchChatMessageText: vi.fn(async () => undefined),
}));

vi.mock("../team-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../team-identity.js")>()),
  resolveTeamGroupId: vi.fn(async () => "group-1"),
}));

const react = vi.mocked(reactMessageMSTeams);

async function handle(
  messages: OpenClawConfig["messages"],
  activity: Record<string, unknown> = {},
  msteams: MSTeamsConfig = {},
) {
  const cfg: OpenClawConfig = {
    messages,
    channels: {
      msteams: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"], ...msteams },
    },
  };
  const { deps } = createMessageHandlerDeps(cfg);
  const warn = vi.fn();
  deps.log = { ...deps.log, warn };
  await createMSTeamsMessageHandler(deps)(createTurnContext(buildChannelActivity(activity)));
  return { warn };
}

describe("Teams acknowledgement reactions", () => {
  beforeEach(() => {
    dispatch.mockClear();
    react.mockReset();
    react.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reacts to a mentioned channel thread reply through the Graph channel target", async () => {
    await handle(
      { ackReaction: "👀" },
      {
        id: "reply-1",
        conversation: {
          id: `${channelConversationId};messageid=root-1`,
          conversationType: "channel",
        },
      },
    );
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        to: `group-1/${channelConversationId}`,
        messageId: "reply-1",
        threadRootId: "root-1",
        reactionType: "👀",
      }),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reacts to a group chat message through its Graph chat id", async () => {
    await handle(
      { ackReaction: "like", ackReactionScope: "group-all" },
      {
        id: "chat-msg-1",
        entities: [],
        conversation: { id: "19:group@thread.v2", conversationType: "groupChat" },
      },
      { requireMention: false },
    );
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "conversation:19:group@thread.v2",
        messageId: "chat-msg-1",
        reactionType: "like",
      }),
    );
    expect(react.mock.calls[0]?.[0]).not.toHaveProperty("threadRootId");
  });

  it.each([
    { name: "unmentioned under group-mentions", scope: "group-mentions" as const, acked: false },
    { name: "unmentioned under group-all", scope: "group-all" as const, acked: true },
    { name: "scope off", scope: "off" as const, acked: false },
  ])("applies the shared scope to admitted turns: $name", async ({ scope, acked }) => {
    await handle(
      { ackReaction: "👀", ackReactionScope: scope },
      { entities: [] },
      { requireMention: false },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledTimes(acked ? 1 : 0);
  });

  it("does not use the identity fallback when messages.ackReaction is unset", async () => {
    await handle({ ackReactionScope: "all" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(react).not.toHaveBeenCalled();
  });

  it("skips Bot Framework personal chat ids that Graph cannot address", async () => {
    await handle(
      { ackReaction: "👀", ackReactionScope: "all" },
      {
        conversation: { id: "a:personal-chat", conversationType: "personal" },
        channelData: {},
        entities: [],
      },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(react).not.toHaveBeenCalled();
  });

  it("keeps the turn running when the reaction write fails", async () => {
    react.mockRejectedValueOnce(new Error("Graph 403"));
    const { warn } = await handle({ ackReaction: "👀" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "ack reaction failed",
        expect.objectContaining({
          messageId: "msg-1",
          error: expect.stringContaining("Graph 403"),
        }),
      ),
    );
  });
});
