import { describe, expect, it } from "vitest";
import { resolveSilentReplyFallbackText } from "./pi-embedded-subscribe.handlers.messages.js";

describe("resolveSilentReplyFallbackText", () => {
  it("preserves NO_REPLY unchanged", () => {
    expect(resolveSilentReplyFallbackText("NO_REPLY")).toBe("NO_REPLY");
  });

  it("passes through normal assistant text unchanged", () => {
    expect(resolveSilentReplyFallbackText("normal assistant reply")).toBe("normal assistant reply");
  });

  it("passes through empty string unchanged", () => {
    expect(resolveSilentReplyFallbackText("")).toBe("");
  });
});
