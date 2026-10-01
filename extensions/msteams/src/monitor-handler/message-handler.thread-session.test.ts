// Msteams tests cover message handler.thread session plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveMSTeamsRouteSessionKey } from "./thread-session.js";

const channelConversationSessionKey = "agent:main:msteams:channel:19:channel@thread.tacv2";

describe("msteams thread session isolation", () => {
  it("returns the canonical channel key on opt-in even with compounded thread suffixes", () => {
    expect(
      resolveMSTeamsRouteSessionKey({
        baseSessionKey: `${channelConversationSessionKey}:thread:old:thread:older`,
        isChannel: true,
        threadSessionPolicy: "channel",
        conversationMessageId: "new-root",
      }),
    ).toBe(channelConversationSessionKey);
  });
});
