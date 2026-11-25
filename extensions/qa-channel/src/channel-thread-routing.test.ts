import { describe, expect, it } from "vitest";
import { qaChannelPlugin } from "../api.js";

describe("qa-channel structured thread routing", () => {
  it.each(["thread:qa-room/thread-1", "channel:qa-room"])(
    "keeps structured thread identity authoritative over reply metadata for %s",
    async (target) => {
      const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target,
        replyToId: "reply-1",
        threadId: "thread-1",
        currentSessionKey: "agent:main:qa-channel:channel:thread:qa-room/thread-1:thread:stale",
      });

      expect(route?.sessionKey).toBe(
        "agent:main:qa-channel:channel:channel:qa-room:thread:thread-1",
      );
      expect(route?.baseSessionKey).toBe("agent:main:qa-channel:channel:channel:qa-room");
      expect(route?.threadId).toBe("thread-1");
    },
  );
});
