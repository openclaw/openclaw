// LINE outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Slack / Signal / Matrix /
// Feishu / Mattermost / Telegram / Google Chat / QQBot / IRC / SMS).
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";

describe("line outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(linePlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(linePlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
