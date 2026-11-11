import { describe, expect, it } from "vitest";
import { resolveSpawnRequesterConversationTarget } from "./spawn-requester-origin.js";

describe("resolveSpawnRequesterConversationTarget", () => {
  it("uses the routed current target with its thread before the native channel id", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        currentMessagingTarget: " room:parent ",
        currentChannelId: "native-parent",
        currentThreadTs: 0,
      }),
    ).toEqual({ to: "room:parent", threadId: 0 });
  });

  it.each([undefined, "explicit-thread"])(
    "keeps an explicit destination paired with its own thread (%s)",
    (agentThreadId) => {
      expect(
        resolveSpawnRequesterConversationTarget({
          agentTo: "room:explicit",
          agentThreadId,
          currentMessagingTarget: "room:ambient",
          currentThreadTs: "ambient-thread",
          currentConversationOrigin: "caller-token",
        }),
      ).toEqual({ to: "room:explicit", threadId: agentThreadId });
    },
  );

  it("treats blank conversation fields as absent", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        agentTo: " ",
        currentMessagingTarget: " ",
        currentChannelId: " ",
        currentThreadTs: " ",
      }),
    ).toEqual({});
  });

  it("preserves an explicit thread without borrowing an ambient destination", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        agentThreadId: "explicit-thread",
        currentChannelId: "room:ambient",
      }),
    ).toEqual({ threadId: "explicit-thread" });
  });
});
