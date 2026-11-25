// Browser tests cover request policy plugin behavior.
import { describe, expect, it } from "vitest";
import { isBrowserHostLocalRoute, isPersistentBrowserProfileMutation } from "./request-policy.js";
import { matchBrowserUrlPattern } from "./url-pattern.js";

describe("isPersistentBrowserProfileMutation", () => {
  it.each([
    ["POST", "profiles/create"],
    ["POST", "/profiles/import"],
    ["POST", "/reset-profile"],
    ["DELETE", "/profiles/poc"],
  ])("treats %s %s as a persistent profile mutation", (method, path) => {
    expect(isPersistentBrowserProfileMutation(method, path)).toBe(true);
  });
});

describe("isBrowserHostLocalRoute", () => {
  it.each([
    ["POST", "/profiles/import"],
    ["GET", "/system-profiles"],
    ["GET", "/system-profile-import/status"],
    ["POST", "/system-profile-import/dismiss"],
  ])("pins %s %s to the host", (method, path) => {
    expect(isBrowserHostLocalRoute(method, path)).toBe(true);
  });
});

describe("browser url pattern matching", () => {
  it("matches exact URLs", () => {
    expect(matchBrowserUrlPattern("https://example.com/a", "https://example.com/a")).toBe(true);
    expect(matchBrowserUrlPattern("https://example.com/a", "https://example.com/b")).toBe(false);
  });

  it("rejects empty patterns", () => {
    expect(matchBrowserUrlPattern("", "https://example.com")).toBe(false);
    expect(matchBrowserUrlPattern("   ", "https://example.com")).toBe(false);
  });

  it("rejects a nested star pattern without scanning the whole event loop", () => {
    const pattern = "*a".repeat(14);
    const url = `${"a".repeat(29)}x`;
    const started = Date.now();
    expect(matchBrowserUrlPattern(pattern, url)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
    expect(matchBrowserUrlPattern("*a".repeat(3), "xa ya za")).toBe(true);
  });

  it("matches a repeated star literal in one pass per segment", () => {
    const path = "a".repeat(20_000);
    const started = Date.now();
    expect(matchBrowserUrlPattern("https://example.com/*a*", `https://example.com/${path}`)).toBe(
      true,
    );
    expect(Date.now() - started).toBeLessThan(250);
    expect(matchBrowserUrlPattern("https://example.com/*a*", "https://example.com/bbb")).toBe(
      false,
    );
    const separated = "ab".repeat(10_000);
    const separatedStarted = Date.now();
    expect(
      matchBrowserUrlPattern("https://example.com/*a*", `https://example.com/${separated}`),
    ).toBe(true);
    expect(Date.now() - separatedStarted).toBeLessThan(250);
    expect(
      matchBrowserUrlPattern(
        "https://example.com/*a*",
        `https://example.com/${"b".repeat(10_000)}`,
      ),
    ).toBe(false);
  });
});
