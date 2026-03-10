import { describe, expect, it } from "vitest";
import { sanitizeOutboundText } from "./sanitize-outbound.js";

describe("sanitizeOutboundText", () => {
  it("strips [[reply_to:ID]] tags", () => {
    const result = sanitizeOutboundText("Hello [[reply_to:123]] world");
    expect(result).not.toContain("[[reply_to");
    expect(result).toContain("Hello");
    expect(result).toContain("world");
  });

  it("strips [[reply_to_current]] tags", () => {
    const result = sanitizeOutboundText("Hello [[reply_to_current]] world");
    expect(result).not.toContain("[[reply_to_current]]");
    expect(result).toContain("Hello");
    expect(result).toContain("world");
  });

  it("strips reply tags with extra whitespace inside brackets", () => {
    expect(sanitizeOutboundText("[[ reply_to : abc-456 ]]")).toBe("");
  });

  it("strips multiple reply tags in one string", () => {
    const input = "[[reply_to:1]] Hey [[reply_to_current]] there";
    const result = sanitizeOutboundText(input);
    expect(result).not.toContain("[[");
    expect(result).toContain("Hey");
    expect(result).toContain("there");
  });

  it("is case-insensitive for reply tags", () => {
    expect(sanitizeOutboundText("[[REPLY_TO:99]]ok")).not.toContain("[[");
    expect(sanitizeOutboundText("[[Reply_To_Current]]ok")).not.toContain("[[");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeOutboundText("")).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(sanitizeOutboundText("no tags here")).toBe("no tags here");
  });
});
