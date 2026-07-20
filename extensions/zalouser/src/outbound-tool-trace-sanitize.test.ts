// Zalouser outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Telegram #95774 / Signal #97360 /
// Matrix #97372 / Slack #97367). The hook runs in the shared outbound pipeline
// before chunking, so text chunks and media captions are both covered.
import { describe, expect, it } from "vitest";
import { zalouserPlugin } from "./channel.js";

function sanitizeOutboundText(text: string): string {
  const sanitizeText = zalouserPlugin.outbound?.sanitizeText;
  if (!sanitizeText) {
    throw new Error("Expected Zalouser outbound sanitizeText hook");
  }
  return sanitizeText({ text, payload: { text } });
}

describe("zalouser outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(sanitizeOutboundText(text)).toBe("Done.");
  });

  it("strips XML tool-call scaffolding leaked into assistant text", () => {
    const text = '<tool_call>{"name":"exec"}</tool_call>Message sent.';
    expect(sanitizeOutboundText(text)).toBe("Message sent.");
  });

  it("strips multiline tool-response scaffolding leaked into assistant text", () => {
    const text = [
      "Checking now.",
      "<function_response>",
      'Searching for: "message"',
      "</function_response>",
      "Message sent.",
    ].join("\n");
    expect(sanitizeOutboundText(text)).toBe("Checking now.\n\nMessage sent.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(sanitizeOutboundText(text)).toBe(text);
  });

  it("preserves internal trace examples inside fenced code", () => {
    const text = ["Example:", "```", "⚠️ 🛠️ `search repos (agent)` failed", "```"].join("\n");
    expect(sanitizeOutboundText(text)).toBe(text);
  });

  it("returns empty text for trace-only assistant output", () => {
    expect(sanitizeOutboundText("⚠️ 🛠️ `search repos (agent)` failed")).toBe("");
  });

  it("preserves markdown and still chunks sanitized text", () => {
    const text = "**Hi** [docs](https://example.com)\n\n- item one\n- item two";

    const sanitized = sanitizeOutboundText(text);
    expect(sanitized).toBe(text);

    const chunks = zalouserPlugin.outbound?.chunker?.(sanitized, 2000);
    expect(chunks).toEqual([text]);
  });
});
