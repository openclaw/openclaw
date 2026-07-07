// Nextcloud Talk outbound must strip assistant internal tool-trace scaffolding,
// matching the sibling channel fixes tracked under #90684 (Slack / Signal /
// Matrix / Telegram / Google Chat / QQBot / IRC / SMS / Feishu / LINE).
import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";

describe("nextcloud-talk outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(
      nextcloudTalkPlugin.outbound?.sanitizeText?.({ text, payload: { text } }),
    ).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(
      nextcloudTalkPlugin.outbound?.sanitizeText?.({ text, payload: { text } }),
    ).toBe(text);
  });
});
