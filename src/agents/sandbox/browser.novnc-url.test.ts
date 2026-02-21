import { describe, expect, it } from "vitest";
import { buildNoVncObserverUrl } from "./browser.js";

describe("buildNoVncObserverUrl", () => {
  it("builds the default observer URL without password", () => {
    expect(buildNoVncObserverUrl(45678)).toBe(
      "http://127.0.0.1:45678/vnc.html?autoconnect=1&resize=remote",
    );
  });

  it("adds an encoded password query parameter when provided", () => {
    expect(buildNoVncObserverUrl(45678, "a+b c&d")).toBe(
      "http://127.0.0.1:45678/vnc.html?autoconnect=1&resize=remote&password=a%2Bb+c%26d",
    );
  });
});
