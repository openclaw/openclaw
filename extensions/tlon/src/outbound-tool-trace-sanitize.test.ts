// Tlon outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Feishu / Mattermost / Slack /
// Signal / Matrix / Telegram / Google Chat / QQBot / IRC / SMS).
// sanitizeAssistantVisibleText keeps ordinary markdown prose intact for Tlon
// chat rendering.
import { describe, expect, it } from "vitest";
import { tlonPlugin } from "./channel.js";

describe("tlon outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(tlonPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(tlonPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
