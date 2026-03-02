import { describe, expect, it } from "vitest";
import {
  buildNoVncDirectUrl,
  buildNoVncObserverTokenUrl,
  buildNoVncObserverTargetUrl,
  consumeNoVncObserverToken,
  generateNoVncPassword,
  issueNoVncObserverToken,
  resetNoVncObserverTokensForTests,
} from "./novnc-auth.js";

describe("noVNC auth helpers", () => {
  it("builds the default observer URL without password", () => {
    expect(buildNoVncDirectUrl(45678)).toBe("http://127.0.0.1:45678/vnc.html");
  });

  it("builds a fragment-based observer target URL with password", () => {
    expect(buildNoVncObserverTargetUrl({ port: 45678, password: "a+b c&d" })).toBe(
      "http://127.0.0.1:45678/vnc.html#autoconnect=1&resize=remote&password=a%2Bb+c%26d",
    );
  });

  it("issues one-time short-lived observer tokens", () => {
    resetNoVncObserverTokensForTests();
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234",
      nowMs: 1000,
      ttlMs: 100,
    });
    expect(buildNoVncObserverTokenUrl("http://127.0.0.1:19999", token)).toBe(
      `http://127.0.0.1:19999/sandbox/novnc?token=${token}`,
    );
    expect(consumeNoVncObserverToken(token, 1050)).toEqual({
      noVncPort: 50123,
      password: "abcd1234",
    });
    expect(consumeNoVncObserverToken(token, 1050)).toBeNull();
  });

  it("expires observer tokens", () => {
    resetNoVncObserverTokensForTests();
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234",
      nowMs: 1000,
      ttlMs: 100,
    });
    expect(consumeNoVncObserverToken(token, 1200)).toBeNull();
  });

  it("generates 8-char alphanumeric passwords", () => {
    const password = generateNoVncPassword();
    expect(password).toMatch(/^[a-zA-Z0-9]{8}$/);
  });
});
