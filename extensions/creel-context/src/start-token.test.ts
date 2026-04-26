import { describe, expect, it } from "vitest";
import { detectStartToken } from "./start-token.js";

describe("detectStartToken", () => {
  it("extracts the token from a Telegram /start payload", () => {
    expect(detectStartToken("/start abc123def456ghi789jkl")).toEqual({
      token: "abc123def456ghi789jkl",
    });
  });

  it("strips the @BotName suffix Telegram appends in groups", () => {
    expect(detectStartToken("/start@MyBot abc123def456ghi789jkl")).toEqual({
      token: "abc123def456ghi789jkl",
    });
  });

  it("ignores trailing arguments — Telegram contract only uses the first", () => {
    expect(detectStartToken("/start abc123def456ghi789jkl extra noise")).toEqual({
      token: "abc123def456ghi789jkl",
    });
  });

  it("returns null when /start has no payload", () => {
    expect(detectStartToken("/start")).toBeNull();
    expect(detectStartToken("/start ")).toBeNull();
  });

  it("returns null when payload is too short (anti-bruteforce sanity)", () => {
    expect(detectStartToken("/start short")).toBeNull();
  });

  it("returns null for unrelated bodies", () => {
    expect(detectStartToken("hi there")).toBeNull();
    expect(detectStartToken("")).toBeNull();
    expect(detectStartToken(null)).toBeNull();
    expect(detectStartToken(undefined)).toBeNull();
  });

  it("rejects payloads containing characters outside Telegram's start alphabet", () => {
    expect(detectStartToken("/start abc!@#$ short")).toBeNull();
    // Telegram's `start` parameter strips +, /, =, . — none of these tokens
    // could ever be delivered, so we reject to avoid mistakenly accepting
    // a forged or smuggled value.
    expect(detectStartToken("/start AAAA+BBBB_CCCC=DDDD")).toBeNull();
    expect(detectStartToken("/start abcd.efgh.ijkl.mnop")).toBeNull();
  });

  it("accepts base64url-no-padding tokens (Telegram's real shape)", () => {
    expect(detectStartToken("/start AAAA-BBBB_CCCC-DDDD")).toEqual({
      token: "AAAA-BBBB_CCCC-DDDD",
    });
  });
});
