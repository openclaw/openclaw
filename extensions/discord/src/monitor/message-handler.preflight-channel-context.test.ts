// Discord tests cover message handler.preflight channel context plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveDiscordPreflightChannelContext } from "./message-handler.preflight-channel-context.js";

describe("resolveDiscordPreflightChannelContext", () => {
  it("uses Unicode channel names for display without changing config matching slugs", () => {
    const context = resolveDiscordPreflightChannelContext({
      isGuildMessage: true,
      messageChannelId: "channel-1",
      channelName: "baseline-\uC2E4\uD5D8",
      guildName: "Guild",
      guildInfo: {
        channels: { baseline: { enabled: true }, "baseline-\uC2E4\uD5D8": { enabled: false } },
      },
      threadChannel: null,
    });

    expect(context.channelConfig).toMatchObject({ allowed: true, matchKey: "baseline" });
    expect(context.displayChannelSlug).toBe("baseline-\uC2E4\uD5D8");
  });
});
