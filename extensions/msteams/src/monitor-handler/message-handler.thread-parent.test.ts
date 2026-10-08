import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphThreadMessage } from "../graph-thread.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
} from "./message-handler.test-support.js";
import { resolveMSTeamsRouteSessionKey } from "./thread-session.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
const graph = vi.hoisted(() => ({
  fetchChannelMessage: vi.fn<() => Promise<GraphThreadMessage | undefined>>(),
  fetchThreadReplies: vi.fn(async () => []),
}));
vi.mock("../graph-thread.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../graph-thread.js")>()),
  ...graph,
  fetchChatMessageText: vi.fn(async () => undefined),
}));
vi.mock("../team-identity.js", () => ({ resolveTeamGroupId: vi.fn(async () => "group-1") }));

let sequence = 0;
function reply(root: string, id: string): MSTeamsTurnContext {
  return {
    activity: buildChannelActivity({
      id,
      replyToId: "nested-reply",
      conversation: {
        id: `${channelConversationId};messageid=${root}`,
        conversationType: "channel",
      },
    }),
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => undefined),
    deleteActivity: vi.fn(async () => undefined),
  };
}
function setup() {
  const fixture = createMessageHandlerDeps({ channels: { msteams: { groupPolicy: "open" } } });
  return {
    ...fixture,
    handler: createMSTeamsMessageHandler(fixture.deps),
    root: `parent-root-${++sequence}`,
  };
}

describe("Teams thread parent hydration", () => {
  beforeEach(() => {
    dispatch.mockClear();
    graph.fetchChannelMessage.mockReset();
    graph.fetchThreadReplies.mockClear();
  });
  it("hydrates the canonical root once across repeated replies", async () => {
    const { handler, enqueueSystemEvent, root } = setup();
    graph.fetchChannelMessage.mockResolvedValue({
      id: root,
      from: { user: { displayName: "Alice" } },
      body: { content: "Original question", contentType: "text" },
    });
    await handler(reply(root, "reply-1"));
    await handler(reply(root, "reply-2"));
    expect(
      enqueueSystemEvent.mock.calls.filter(([text]) => text.startsWith("Replying to @")),
    ).toEqual([
      [
        "Replying to @Alice: Original question",
        {
          sessionKey: `agent:main:msteams:channel:${channelConversationId}:thread:${root}`,
          contextKey: `msteams:thread-parent:${channelConversationId}:${root}`,
        },
      ],
    ]);
    expect(graph.fetchChannelMessage).toHaveBeenCalledExactlyOnceWith(
      "token",
      "group-1",
      channelConversationId,
      root,
      expect.objectContaining({ label: "MS Teams inbound preprocessing" }),
    );
    expect(graph.fetchThreadReplies).toHaveBeenCalledWith(
      "token",
      "group-1",
      channelConversationId,
      root,
      expect.objectContaining({ label: "MS Teams inbound preprocessing" }),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("continues dispatch without a parent event after Graph failure", async () => {
    const { handler, enqueueSystemEvent, root } = setup();
    graph.fetchChannelMessage.mockRejectedValueOnce(new Error("graph down"));
    await handler(reply(root, "reply-failure"));
    expect(
      enqueueSystemEvent.mock.calls.filter(([text]) => text.startsWith("Replying to @")),
    ).toEqual([]);
    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

const base = "agent:main:msteams:channel:19:channel@thread.tacv2";

describe("Teams cached thread session keys (#66771)", () => {
  it.each([
    { conversationMessageId: "New-Root", expected: `${base}:thread:new-root` },
    { conversationMessageId: undefined, expected: base },
  ])(
    "re-derives a pre-suffixed base for $conversationMessageId",
    ({ conversationMessageId, expected }) => {
      expect(
        resolveMSTeamsRouteSessionKey({
          baseSessionKey: `${base}:thread:old:thread:malformed`,
          isChannel: true,
          conversationMessageId,
        }),
      ).toBe(expected);
    },
  );
});
