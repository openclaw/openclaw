// Twitch outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Matrix #97372 / Slack #97367 /
// IRC #97214 / Google Chat #95084). The hook runs in core delivery before chunk
// planning, so the 500-char Twitch chunker only ever sees sanitized text.
import { describe, expect, it } from "vitest";
import { twitchPlugin } from "./plugin.js";

describe("twitch outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(twitchPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("strips XML tool-call scaffolding leaked into assistant text", () => {
    const text = '<tool_call>{"name":"exec"}</tool_call>Stream is live.';

    expect(twitchPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(
      "Stream is live.",
    );
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(twitchPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
