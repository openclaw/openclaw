import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it } from "vitest";
import {
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  normalizeCdpWsUrl,
  redactCdpErrorText,
} from "./cdp.helpers.js";
import { BrowserCdpEndpointBlockedError, toBrowserErrorResponse } from "./errors.js";

describe("browser error mapping", () => {
  it("maps blocked browser targets to conflict responses", () => {
    const err = new Error("Target blocked after navigation");
    err.name = "BlockedBrowserTargetError";
    expect(toBrowserErrorResponse(err)).toEqual({
      status: 409,
      message: err.message,
      reason: "navigation_blocked",
    });
  });
  it("sanitizes navigation-target SSRF policy details", () => {
    expect(toBrowserErrorResponse(new SsrFBlockedError("raw private-network policy"))).toEqual({
      status: 400,
      message: "browser navigation blocked by policy",
      reason: "navigation_blocked",
    });
  });
  it("distinguishes endpoint policy blocks from navigation errors", () => {
    expect(toBrowserErrorResponse(new BrowserCdpEndpointBlockedError())).toEqual({
      status: 400,
      message: "browser endpoint blocked by policy",
    });
  });
});

it("rejects malformed WebSocket URLs", () => {
  expect(isWebSocketUrl("not-a-url")).toBe(false);
});
it("rejects malformed direct CDP endpoints", () => {
  expect(isDirectCdpWebSocketEndpoint("not-a-url")).toBe(false);
});

it.each([
  [
    "ws://0.0.0.0:3000/devtools/browser/ABC?session=1&token=ws-token",
    "https://user:pass@example.com:9443?token=cdp-token&apiKey=abc",
    "wss://user:pass@example.com:9443/devtools/browser/ABC?session=1&token=ws-token&apiKey=abc",
  ],
  [
    "ws://[::]:3000/devtools/browser/ABC",
    "http://example.com",
    "ws://example.com/devtools/browser/ABC",
  ],
  ["ws://remote.example", "https://remote.example?token=abc", "wss://remote.example/?token=abc"],
])("normalizes %s against the configured authority", (reported, configured, expected) => {
  expect(normalizeCdpWsUrl(reported, configured)).toBe(expected);
});

describe("CDP URL edge cases", () => {
  it("normalizes WebSocket endpoints and malformed URL fallbacks", () => {
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://host:9222/cdp")).toBe("http://host:9222");
    expect(normalizeCdpHttpBaseForJsonEndpoints("wss://host/devtools/browser/abc?t=1")).toBe(
      "https://host/?t=1",
    );
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://").startsWith("http:")).toBe(true);
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
});
