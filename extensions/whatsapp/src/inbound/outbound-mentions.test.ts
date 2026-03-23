import { describe, expect, it } from "vitest";
import { extractOutboundMentions } from "./outbound-mentions.js";

describe("extractOutboundMentions", () => {
  it("returns empty array for text with no mentions", () => {
    expect(extractOutboundMentions("Hello world")).toEqual([]);
  });

  it("extracts single mention with plus prefix", () => {
    expect(extractOutboundMentions("Hey @+1234567890")).toEqual(["1234567890@s.whatsapp.net"]);
  });

  it("extracts single mention without plus prefix", () => {
    expect(extractOutboundMentions("Hey @1234567890")).toEqual(["1234567890@s.whatsapp.net"]);
  });

  it("extracts multiple mentions", () => {
    const result = extractOutboundMentions("Hey @+1234567890 and @+9876543210!");
    expect(result).toEqual(["1234567890@s.whatsapp.net", "9876543210@s.whatsapp.net"]);
  });

  it("deduplicates repeated mentions", () => {
    const result = extractOutboundMentions("@+1234567890 and @+1234567890 again");
    expect(result).toEqual(["1234567890@s.whatsapp.net"]);
  });

  it("deduplicates same number with and without plus", () => {
    const result = extractOutboundMentions("@+1234567890 and @1234567890");
    expect(result).toEqual(["1234567890@s.whatsapp.net"]);
  });

  it("ignores too-short digit sequences (< 7 digits)", () => {
    expect(extractOutboundMentions("@123456")).toEqual([]);
    expect(extractOutboundMentions("@12345")).toEqual([]);
  });

  it("accepts 7-digit numbers", () => {
    expect(extractOutboundMentions("@1234567")).toEqual(["1234567@s.whatsapp.net"]);
  });

  it("accepts 15-digit numbers (E.164 max)", () => {
    expect(extractOutboundMentions("@123456789012345")).toEqual(["123456789012345@s.whatsapp.net"]);
  });

  it("accepts LID-length numbers (up to 25 digits)", () => {
    expect(extractOutboundMentions("@1234567890123456789")).toEqual([
      "1234567890123456789@s.whatsapp.net",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(extractOutboundMentions("")).toEqual([]);
  });

  it("handles mention embedded in sentence", () => {
    expect(extractOutboundMentions("Check with @+85291234567 about the plan")).toEqual([
      "85291234567@s.whatsapp.net",
    ]);
  });

  it("ignores email-like patterns where @ is not at token start", () => {
    expect(extractOutboundMentions("contact@1234567890 for info")).toEqual([]);
    expect(extractOutboundMentions("user@+9876543210")).toEqual([]);
  });

  it("ignores pasted JID-like tokens with trailing non-boundary chars", () => {
    expect(extractOutboundMentions("@123456789012345:1@lid")).toEqual([]);
    expect(extractOutboundMentions("@1234567890abc")).toEqual([]);
  });

  it("ignores tokens with underscore, dash, or slash suffix", () => {
    expect(extractOutboundMentions("@1234567_user")).toEqual([]);
    expect(extractOutboundMentions("@1234567-foo")).toEqual([]);
    expect(extractOutboundMentions("@1234567/bar")).toEqual([]);
  });

  it("ignores tokens with non-ASCII letter suffix", () => {
    expect(extractOutboundMentions("@1234567中文")).toEqual([]);
    expect(extractOutboundMentions("@1234567é")).toEqual([]);
  });

  it("skips mentions inside backtick code spans", () => {
    expect(extractOutboundMentions("see `@+1234567890` for details")).toEqual([]);
    expect(
      extractOutboundMentions("code `@+1234567890` but also @+9876543210 outside"),
    ).toEqual(["9876543210@s.whatsapp.net"]);
  });

  it("does not create false mention when code span removal merges tokens", () => {
    expect(extractOutboundMentions("x`y`@1234567890")).toEqual([]);
  });

  it("matches mention followed by punctuation", () => {
    expect(extractOutboundMentions("hey @+1234567890, what's up?")).toEqual([
      "1234567890@s.whatsapp.net",
    ]);
    expect(extractOutboundMentions("ask @+1234567890.")).toEqual([
      "1234567890@s.whatsapp.net",
    ]);
    expect(extractOutboundMentions("(@+1234567890)")).toEqual([
      "1234567890@s.whatsapp.net",
    ]);
  });

  describe("with participantJidMap", () => {
    it("uses original JID from map for phone-based participants", () => {
      const jidMap = new Map([["+1234567890", "1234567890:0@s.whatsapp.net"]]);
      expect(extractOutboundMentions("Hey @+1234567890", jidMap)).toEqual([
        "1234567890:0@s.whatsapp.net",
      ]);
    });

    it("uses original LID JID from map instead of defaulting to @s.whatsapp.net", () => {
      const jidMap = new Map([["+1234567890123456789", "1234567890123456789:0@lid"]]);
      expect(extractOutboundMentions("Hey @+1234567890123456789", jidMap)).toEqual([
        "1234567890123456789:0@lid",
      ]);
    });

    it("falls back to @s.whatsapp.net when number not in map", () => {
      const jidMap = new Map([["+9999999999", "9999999999@s.whatsapp.net"]]);
      expect(extractOutboundMentions("Hey @+1234567890", jidMap)).toEqual([
        "1234567890@s.whatsapp.net",
      ]);
    });

    it("handles mix of mapped and unmapped mentions", () => {
      const jidMap = new Map([
        ["+1234567890", "1234567890@s.whatsapp.net"],
        ["+9876543210123456789", "9876543210123456789:0@lid"],
      ]);
      const result = extractOutboundMentions(
        "Hey @+1234567890 and @+9876543210123456789 and @+5555555555",
        jidMap,
      );
      expect(result).toEqual([
        "1234567890@s.whatsapp.net",
        "9876543210123456789:0@lid",
        "5555555555@s.whatsapp.net",
      ]);
    });

    it("resolves LID mention correctly with hosted.lid suffix", () => {
      const jidMap = new Map([["+12345678901234567890", "12345678901234567890:1@hosted.lid"]]);
      expect(extractOutboundMentions("@+12345678901234567890", jidMap)).toEqual([
        "12345678901234567890:1@hosted.lid",
      ]);
    });
  });
});
