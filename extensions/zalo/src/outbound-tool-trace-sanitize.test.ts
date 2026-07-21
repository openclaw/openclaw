// Zalo outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Telegram / Google Chat / IRC /
// Matrix / Signal / Slack / SMS / Feishu).
import { describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";

describe("zalo outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(zaloPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(zaloPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
