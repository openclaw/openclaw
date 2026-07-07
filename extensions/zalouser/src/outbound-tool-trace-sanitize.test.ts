// Zalouser outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Telegram #95774 / Signal #97360 /
// Matrix #97372 / Slack #97367). The hook runs in the shared outbound pipeline
// before chunking, so text chunks and media captions are both covered.
import { describe, expect, it } from "vitest";
import { zalouserPlugin } from "./channel.js";

describe("zalouser outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(zalouserPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(zalouserPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });

  it("preserves markdown and still chunks sanitized text", () => {
    const text = "**Hi** [docs](https://example.com)\n\n- item one\n- item two";

    const sanitized = zalouserPlugin.outbound?.sanitizeText?.({ text, payload: { text } });
    expect(sanitized).toBe(text);

    const chunks = zalouserPlugin.outbound?.chunker?.(sanitized ?? "", 2000);
    expect(chunks).toEqual([text]);
  });
});
