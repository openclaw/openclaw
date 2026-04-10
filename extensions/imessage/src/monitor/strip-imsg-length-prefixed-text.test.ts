import { describe, expect, it } from "vitest";
import { stripImessageLengthPrefixedUtf8Text } from "./strip-imsg-length-prefixed-text.js";

describe("stripImessageLengthPrefixedUtf8Text", () => {
  it("removes a single-byte length prefix that wraps the full remainder", () => {
    const raw = `${String.fromCharCode(5)}hello`;
    expect(stripImessageLengthPrefixedUtf8Text(raw)).toBe("hello");
  });

  it("removes a multi-byte varint length when it wraps the full remainder", () => {
    const inner = "a".repeat(127);
    const buf = Buffer.allocUnsafe(1 + inner.length);
    buf.writeUInt8(0x7f, 0);
    buf.write(inner, 1, "utf8");
    expect(stripImessageLengthPrefixedUtf8Text(buf.toString("utf8"))).toBe(inner);
  });

  it("preserves plain text", () => {
    expect(stripImessageLengthPrefixedUtf8Text("Mrrrrow! 🐱")).toBe("Mrrrrow! 🐱");
  });

  it("preserves text when the length does not consume the whole string", () => {
    const raw = `${String.fromCharCode(5)}hi`;
    expect(stripImessageLengthPrefixedUtf8Text(raw)).toBe(raw);
  });

  it("preserves text when extra bytes follow the wrapped payload", () => {
    const raw = `${String.fromCharCode(5)}hello!`;
    expect(stripImessageLengthPrefixedUtf8Text(raw)).toBe(raw);
  });

  it("returns empty string unchanged", () => {
    expect(stripImessageLengthPrefixedUtf8Text("")).toBe("");
  });
});
