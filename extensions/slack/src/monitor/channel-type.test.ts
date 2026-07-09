// Channel type normalization tests for Slack mpDM ambiguity (#102676).
import { describe, expect, it } from "vitest";
import { normalizeSlackChannelType } from "./channel-type.js";

describe("normalizeSlackChannelType", () => {
  it("passes explicit mpim through unchanged", () => {
    expect(normalizeSlackChannelType("mpim", "G123")).toBe("mpim");
  });

  it("returns im for D-prefix regardless of input", () => {
    expect(normalizeSlackChannelType(undefined, "D123")).toBe("im");
    expect(normalizeSlackChannelType(null, "D123")).toBe("im");
  });

  it("returns channel for C-prefix with no explicit type", () => {
    expect(normalizeSlackChannelType(undefined, "C123")).toBe("channel");
    expect(normalizeSlackChannelType(null, "C123")).toBe("channel");
  });

  it("returns undefined for G-prefix with no explicit type — cannot distinguish mpim from private channel", () => {
    // Without channel_type, a G-prefixed channel ID is ambiguous
    // between an mpDM (correct peer kind "group") and a private
    // channel. When the API fallback in resolveSlackConversationContext
    // also fails, signaling ambiguity avoids creating a parallel
    // slack:channel:<id> session alongside the correct one.
    expect(normalizeSlackChannelType(undefined, "G123")).toBeUndefined();
    expect(normalizeSlackChannelType(null, "G123")).toBeUndefined();
  });

  it("still resolves G-prefix when channel_type is explicit", () => {
    expect(normalizeSlackChannelType("group", "G123")).toBe("group");
    expect(normalizeSlackChannelType("channel", "G123")).toBe("channel");
  });

  it("falls back to channel for unknown prefix without channel_type", () => {
    expect(normalizeSlackChannelType(undefined, "X999")).toBe("channel");
  });
});
