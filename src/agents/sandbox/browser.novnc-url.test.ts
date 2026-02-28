import { describe, expect, it } from "vitest";
import {
  buildNoVncDirectUrl,
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  issueNoVncObserverToken,
  resetNoVncObserverTokensForTests,
} from "./novnc-auth.js";

describe("noVNC auth helpers", () => {
  it("builds the default observer URL without password", () => {
    expect(buildNoVncDirectUrl(45678)).toBe(
      "http://127.0.0.1:45678/vnc.html?autoconnect=1&resize=remote",
    );
  });

  it("adds an encoded password query parameter when provided", () => {
    expect(buildNoVncDirectUrl(45678, "a+b c&d")).toBe(
      "http://127.0.0.1:45678/vnc.html?autoconnect=1&resize=remote&password=a%2Bb+c%26d",
    );
  });

  it("issues one-time short-lived observer tokens", () => {
    resetNoVncObserverTokensForTests();
    const token = issueNoVncObserverToken({
      url: "http://127.0.0.1:50123/vnc.html?autoconnect=1&resize=remote&password=abcd1234",
      nowMs: 1000,
      ttlMs: 100,
    });
    expect(buildNoVncObserverTokenUrl("http://127.0.0.1:19999", token)).toBe(
      `http://127.0.0.1:19999/sandbox/novnc?token=${token}`,
    );
    expect(consumeNoVncObserverToken(token, 1050)).toContain("/vnc.html?");
    expect(consumeNoVncObserverToken(token, 1050)).toBeNull();
  });

  it("expires observer tokens", () => {
    resetNoVncObserverTokensForTests();
    const token = issueNoVncObserverToken({
      url: "http://127.0.0.1:50123/vnc.html?autoconnect=1&resize=remote&password=abcd1234",
      nowMs: 1000,
      ttlMs: 100,
    });
    expect(consumeNoVncObserverToken(token, 1200)).toBeNull();
  });
});
