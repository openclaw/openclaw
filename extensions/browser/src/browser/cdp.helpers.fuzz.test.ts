import { parseBrowserHttpUrl } from "openclaw/plugin-sdk/browser-cdp";
import { describe, expect, it } from "vitest";
import {
  getHeadersWithAuth,
  normalizeCdpHttpBaseForJsonEndpoints,
  redactCdpErrorText,
  stripCdpUrlCredentials,
} from "./cdp.helpers.js";

describe("CDP URL edge cases", () => {
  it("normalizes WebSocket endpoints and malformed URL fallbacks", () => {
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://host:9222/cdp")).toBe("http://host:9222");
    expect(normalizeCdpHttpBaseForJsonEndpoints("wss://host:9222/")).toBe("https://host:9222");
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://host/devtools/browser/abc")).toBe(
      "http://host",
    );
    expect(normalizeCdpHttpBaseForJsonEndpoints("wss://host/devtools/browser/abc?t=1")).toBe(
      "https://host/?t=1",
    );
    expect(normalizeCdpHttpBaseForJsonEndpoints("")).toBe("");
    expect(normalizeCdpHttpBaseForJsonEndpoints("garbage")).toBe("garbage");
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://").startsWith("http:")).toBe(true);
    expect(normalizeCdpHttpBaseForJsonEndpoints("wss://").startsWith("https:")).toBe(true);
  });

  it("rejects explicitly configured port zero", () => {
    for (const scheme of ["http", "https", "ws", "wss"]) {
      expect(() => parseBrowserHttpUrl(`${scheme}://127.0.0.1:0`, "test")).toThrow(/invalid port/);
    }
  });

  it("moves URL userinfo out of dependency-facing connection URLs", () => {
    expect(
      stripCdpUrlCredentials(
        "wss://alice:p%40ss@browserless.example/devtools/browser/id?token=keep-query",
      ),
    ).toBe("wss://browserless.example/devtools/browser/id?token=keep-query");
  });

  it("redacts embedded CDP URL credentials from dependency error prose", () => {
    const message = redactCdpErrorText(
      "connect failed for wss://alice:browser-password@browserless.example/devtools/browser/id?token=browser-token",
    );

    expect(message).toContain("browserless.example/devtools/browser/id");
    expect(message).not.toContain("alice");
    expect(message).not.toContain("browser-password");
    expect(message).not.toContain("browser-token");
  });

  it("preserves an existing Authorization header (case-insensitive) over URL userinfo", () => {
    const out = getHeadersWithAuth("https://alice:s3cr3t@example.com/path", {
      authorization: "Bearer preset",
    });
    expect(out.authorization).toBe("Bearer preset");
    expect(out.Authorization).toBeUndefined();
  });
});
