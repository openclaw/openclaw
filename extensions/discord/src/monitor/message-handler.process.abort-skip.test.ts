// Discord tests cover message handler.process.abort skip plugin behavior.
import { describe, expect, it } from "vitest";
import { formatDiscordReplySkip } from "./message-handler.process.js";

describe("formatDiscordReplySkip", () => {
  it("includes target and session when both are present for an aborted skip", () => {
    expect(
      formatDiscordReplySkip({
        kind: "final",
        reason: "aborted before delivery",
        target: "channel:123",
        sessionKey: "agent:main:discord:channel:123",
      }),
    ).toBe(
      "discord final reply skipped (aborted before delivery): target=channel:123 session=agent:main:discord:channel:123",
    );
  });

  it("omits the session tag when sessionKey is undefined", () => {
    expect(
      formatDiscordReplySkip({
        kind: "tool",
        reason: "aborted before delivery",
        target: "channel:456",
      }),
    ).toBe("discord tool reply skipped (aborted before delivery): target=channel:456");
  });
});
