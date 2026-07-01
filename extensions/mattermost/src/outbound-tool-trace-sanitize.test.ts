// Mattermost outbound must strip assistant internal tool-trace scaffolding,
// matching the sibling channel fixes tracked under #90684 (Slack / Telegram /
// Google Chat / IRC / SMS). sanitizeAssistantVisibleText keeps Markdown prose.
import { describe, expect, it } from "vitest";
import { mattermostPlugin } from "./channel.js";

describe("mattermost outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(mattermostPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(mattermostPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
