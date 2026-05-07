import { describe, expect, it } from "vitest";
import {
  stripImessageLengthPrefixedUtf8Text,
  tryStripImessageLengthPrefixedUtf8Buffer,
} from "./strip-imsg-length-prefixed-text.js";

describe("stripImessageLengthPrefixedUtf8Text", () => {
  it("removes a length-delimited field wrapper from text", () => {
    const raw = `${String.fromCharCode(0x0a, 5)}hello`;
    expect(stripImessageLengthPrefixedUtf8Text(raw)).toBe("hello");
  });

  it("removes a wrapped payload when the payload length byte is ASCII-printable", () => {
    const inner = "Mrrrrow! 🐱 Ich bin wach und bereit!";
    const raw = `${String.fromCharCode(0x0a, Buffer.byteLength(inner, "utf8"))}${inner}`;
    expect(stripImessageLengthPrefixedUtf8Text(raw)).toBe(inner);
  });

  it("removes a payload behind a two-byte varint length (raw buffer)", () => {
    const inner = "a".repeat(128);
    const buf = Buffer.allocUnsafe(3 + Buffer.byteLength(inner, "utf8"));
    buf.writeUInt8(0x0a, 0);
    buf.writeUInt8(0x80, 1);
    buf.writeUInt8(0x01, 2);
    buf.write(inner, 3, "utf8");
    expect(Buffer.from(tryStripImessageLengthPrefixedUtf8Buffer(buf) ?? []).toString("utf8")).toBe(
      inner,
    );
  });

  it("does not strip plain text whose first bytes can mimic a naked length prefix", () => {
    const inner = `A${"b".repeat(65)}`;
    expect(stripImessageLengthPrefixedUtf8Text(inner)).toBe(inner);
  });

  it("does not strip plain text that starts with a different length-delimited field tag", () => {
    const inner = `B${"a".repeat(98)}`;
    expect(stripImessageLengthPrefixedUtf8Text(inner)).toBe(inner);
  });

  it("removes imsg attributedBody corruption markers from long decoded text", () => {
    expect(stripImessageLengthPrefixedUtf8Text("��\u0000Direkt långtest från Bosse")).toBe(
      "Direkt långtest från Bosse",
    );
    expect(stripImessageLengthPrefixedUtf8Text("�N\u0002Klart. Commit på N2-main")).toBe(
      "Klart. Commit på N2-main",
    );
    expect(stripImessageLengthPrefixedUtf8Text("�\u000f\u0004Pass335 är klart")).toBe(
      "Pass335 är klart",
    );
  });

  it("preserves plain text", () => {
    expect(stripImessageLengthPrefixedUtf8Text("Mrrrrow! 🐱")).toBe("Mrrrrow! 🐱");
  });

  it("preserves plain text that starts with a replacement character", () => {
    expect(stripImessageLengthPrefixedUtf8Text("� unknown glyph at start")).toBe(
      "� unknown glyph at start",
    );
  });

  it("preserves text when the wrapped length does not consume the whole string", () => {
    const raw = `${String.fromCharCode(0x0a, 5)}hi`;
    expect(stripImessageLengthPrefixedUtf8Text(raw)).toBe(raw);
  });

  it("preserves text when the field tag is missing", () => {
    const raw = `${String.fromCharCode(5)}hello`;
    expect(stripImessageLengthPrefixedUtf8Text(raw)).toBe(raw);
  });

  it("returns empty string unchanged", () => {
    expect(stripImessageLengthPrefixedUtf8Text("")).toBe("");
  });
});
