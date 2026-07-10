// Nostr outbound must strip assistant internal tool-trace scaffolding before
// delivery, matching the sanitizeText hook shipped to sibling channels
// (twitch #103109, mattermost #98693, feishu #98705, etc.).
import { describe, expect, it } from "vitest";
import { nostrOutboundAdapter } from "./gateway.js";

function sanitizeOutboundText(text: string): string {
  const sanitizeText = nostrOutboundAdapter.sanitizeText;
  if (!sanitizeText) {
    throw new Error("Expected Nostr outbound sanitizeText hook");
  }
  return sanitizeText({ text, payload: { text } });
}

describe("nostr outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";
    expect(sanitizeOutboundText(text)).toBe("Done.");
  });

  it("strips XML tool-call scaffolding leaked into assistant text", () => {
    const text = '<tool_call>{"name":"exec"}</tool_call>DM delivered.';
    expect(sanitizeOutboundText(text)).toBe("DM delivered.");
  });

  it("strips multiline tool-response scaffolding leaked into assistant text", () => {
    const text = [
      "Checking now.",
      "<function_response>",
      'Searching for: "contact"',
      "</function_response>",
      "DM delivered.",
    ].join("\n");
    expect(sanitizeOutboundText(text)).toBe("Checking now.\n\nDM delivered.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The relay has 2 active subscriptions.";
    expect(sanitizeOutboundText(text)).toBe(text);
  });
});
