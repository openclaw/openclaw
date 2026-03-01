import { describe, expect, it } from "vitest";
import { resolveSilentReplyFallbackText } from "./pi-embedded-subscribe.handlers.messages.js";

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: ["first", "final delivered text"],
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "normal assistant reply",
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [],
      }),
    ).toBe("NO_REPLY");
  });

  it("keeps NO_REPLY when fallback text is only leaked internal tool trace", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [
          'NO_REPLY +#+#+#+#+#+assistant to=functions.olvid_list_groups recipient_name=functions.olvid_list_groups json {"olvidChannelAccountId":""}',
        ],
      }),
    ).toBe("NO_REPLY");
  });

  it("keeps user-facing prefix and strips leaked internal tool trace suffix", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [
          'Sent to group successfully. assistant to=functions.olvid_list_groups recipient_name=functions.olvid_list_groups json {"olvidChannelAccountId":""}',
        ],
      }),
    ).toBe("Sent to group successfully.");
  });
});
