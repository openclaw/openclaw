// Irc tests cover protocol plugin behavior.
import { describe, expect, it } from "vitest";
import { parseIrcLine, parseIrcPrefix, sanitizeIrcTarget } from "./protocol.js";

describe("irc protocol", () => {
  it("parses PRIVMSG lines with prefix and trailing", () => {
    const parsed = parseIrcLine(":alice!u@host PRIVMSG #room :hello world");
    expect(parsed).toEqual({
      prefix: "alice!u@host",
      command: "PRIVMSG",
      params: ["#room"],
      trailing: "hello world",
    });

    expect(parseIrcPrefix(parsed?.prefix)).toEqual({
      nick: "alice",
      user: "u",
      host: "host",
    });
  });

  it("validates targets and rejects control characters", () => {
    expect(sanitizeIrcTarget("#openclaw")).toBe("#openclaw");
    expect(sanitizeIrcTarget(String.raw`\tom`)).toBe(String.raw`\tom`);
    expect(() => sanitizeIrcTarget("#bad\nPING")).toThrow(/Invalid IRC target/);
    expect(() => sanitizeIrcTarget(" user")).toThrow(/Invalid IRC target/);
  });
});
