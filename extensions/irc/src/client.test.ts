// Irc tests cover client plugin behavior.
import { describe, expect, it } from "vitest";
import { buildFallbackNick, buildIrcNickServCommands } from "./client.js";

describe("irc client nickserv", () => {
  it("builds IDENTIFY command when password is set", () => {
    expect(
      buildIrcNickServCommands({
        password: "secret",
      }),
    ).toEqual(["PRIVMSG NickServ :IDENTIFY secret"]);
  });

  it("builds REGISTER command when enabled with email", () => {
    expect(
      buildIrcNickServCommands({
        password: "secret",
        register: true,
        registerEmail: "bot@example.com",
      }),
    ).toEqual([
      "PRIVMSG NickServ :IDENTIFY secret",
      "PRIVMSG NickServ :REGISTER secret bot@example.com",
    ]);
  });

  it("rejects register without registerEmail", () => {
    expect(() =>
      buildIrcNickServCommands({
        password: "secret",
        register: true,
      }),
    ).toThrow(/registerEmail/);
  });

  it("sanitizes outbound NickServ payloads", () => {
    expect(
      buildIrcNickServCommands({
        service: "NickServ\n",
        password: "secret\r\nJOIN #bad",
      }),
    ).toEqual(["PRIVMSG NickServ :IDENTIFY secret JOIN #bad"]);
  });
});

describe("irc client fallback nick", () => {
  it("produces unique fallback nicks across sequential calls", () => {
    const first = buildFallbackNick("bot");
    const second = buildFallbackNick("bot");
    const third = buildFallbackNick("bot");
    // First call gets suffix _ (seq=1), subsequent calls get _2, _3, ...
    expect(first).toBe("bot_");
    expect(second).toMatch(/^bot_\d+$/);
    expect(third).toMatch(/^bot_\d+$/);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("sanitizes whitespace and special characters in nick", () => {
    const nick = buildFallbackNick("my bot!");
    expect(nick).toMatch(/^mybot_\d*$/);
  });

  it("falls back to openclaw when nick consists entirely of special characters", () => {
    const nick = buildFallbackNick("!!!");
    expect(nick).toMatch(/^openclaw_\d*$/);
  });

  it("falls back to openclaw when nick is empty after sanitization", () => {
    const nick = buildFallbackNick("");
    expect(nick).toMatch(/^openclaw_\d*$/);
  });

  it("truncates long nicks to max 30 chars", () => {
    const longNick = "a".repeat(50);
    const nick = buildFallbackNick(longNick);
    expect(nick.length).toBeLessThanOrEqual(30);
    expect(nick).toMatch(/^a+_\d*$/);
  });
});
