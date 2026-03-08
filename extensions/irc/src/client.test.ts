import { describe, expect, it } from "vitest";
import { buildIrcNickServCommands, normalizeTlsFingerprint } from "./client.js";

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

describe("normalizeTlsFingerprint", () => {
  it("normalizes lowercase colon-separated (openssl output format)", () => {
    const input =
      "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99";
    expect(normalizeTlsFingerprint(input)).toBe(
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    );
  });

  it("normalizes bare lowercase hex (no separators)", () => {
    const input = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    expect(normalizeTlsFingerprint(input)).toBe(
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    );
  });

  it("is idempotent on already-normalized uppercase colon form", () => {
    const input =
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    expect(normalizeTlsFingerprint(input)).toBe(input);
  });

  it("strips non-hex characters like hyphens", () => {
    const input =
      "AA-BB-CC-DD-EE-FF-00-11-22-33-44-55-66-77-88-99-AA-BB-CC-DD-EE-FF-00-11-22-33-44-55-66-77-88-99";
    expect(normalizeTlsFingerprint(input)).toBe(
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    );
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTlsFingerprint("")).toBe("");
  });

  it("returns a deterministic but non-matching result for malformed (short) input", () => {
    // Odd-length hex: produces a string that can never match a valid 64-char SHA-256
    // fingerprint, so checkServerIdentity will always reject it (fail-safe behavior).
    const result = normalizeTlsFingerprint("abc");
    expect(result).toBe("AB:C");
    expect(result.replace(/:/g, "").length).not.toBe(64);
  });
});
