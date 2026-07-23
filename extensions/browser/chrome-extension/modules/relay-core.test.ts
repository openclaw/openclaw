// Pure-logic tests for the OpenClaw Chrome extension. Runs under the
// extension-browser vitest glob (extensions/browser/**/*.test.ts).
import { describe, expect, it } from "vitest";
import {
  buildRelayWsProtocols,
  nearestGroupColor,
  parsePairingString,
  reconnectDelayMs,
  relayStatusLabel,
} from "./relay-core.js";

describe("parsePairingString", () => {
  it("parses a valid pairing string the CLI emits", () => {
    const parsed = parsePairingString("ws://127.0.0.1:18797/extension#deadbeefcafe");
    expect(parsed).toEqual({
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: "deadbeefcafe",
    });
  });

  it("round-trips with the CLI pairing format", () => {
    const port = 18797;
    const token = "abc123";
    const pairing = `ws://127.0.0.1:${port}/extension#${token}`;
    const parsed = parsePairingString(pairing);
    if (!parsed) {
      throw new Error("expected pairing string to parse");
    }
    expect(parsed.relayUrl).toBe(`ws://127.0.0.1:${port}/extension`);
    expect(buildRelayWsProtocols(parsed.token)).toEqual([
      "openclaw-extension-relay",
      `openclaw-extension-token.${token}`,
    ]);
  });

  it("rejects malformed strings", () => {
    expect(parsePairingString("")).toBeNull();
    expect(parsePairingString("http://127.0.0.1/extension#tok")).toBeNull();
    expect(parsePairingString("ws://127.0.0.1/other#tok")).toBeNull();
    expect(parsePairingString("ws://127.0.0.1/extension#")).toBeNull();
    expect(parsePairingString("ws://127.0.0.1/extension")).toBeNull();
  });

  it("extracts the additive direct Gateway hint without passing it to the relay", () => {
    const gatewayUrl = "wss://gateway.example.com/base";
    const pairing = `ws://127.0.0.1:18797/extension?gateway=${encodeURIComponent(gatewayUrl)}#tok`;
    expect(parsePairingString(pairing)).toEqual({
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: "tok",
      gatewayUrl,
    });
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially and caps at 30s", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(4)).toBe(16_000);
    expect(reconnectDelayMs(5)).toBe(30_000);
    expect(reconnectDelayMs(50)).toBe(30_000);
  });
});

describe("nearestGroupColor", () => {
  it("maps hex accents to Chrome tab-group color names", () => {
    expect(nearestGroupColor("#FF4500")).toBe("orange");
    expect(nearestGroupColor("#00AA00")).toBe("green");
    expect(nearestGroupColor("#4285F4")).toBe("blue");
  });

  it("falls back to orange for invalid input", () => {
    expect(nearestGroupColor("not-a-color")).toBe("orange");
    expect(nearestGroupColor(undefined)).toBe("orange");
  });
});

describe("relayStatusLabel", () => {
  it("maps non-error states to their fixed labels", () => {
    expect(relayStatusLabel({ state: "on" })).toBe("Connected to OpenClaw");
    expect(relayStatusLabel({ state: "connecting" })).toBe("Connecting…");
    expect(relayStatusLabel({ state: "off" })).toBe("Not connected");
  });

  it("names the host and lists the real causes for a never-opened failure", () => {
    expect(
      relayStatusLabel({
        state: "error",
        relayHost: "127.0.0.1:18789",
        lastError: { wasOpen: false },
      }),
    ).toBe(
      "Can't reach the relay at 127.0.0.1:18789. Check the gateway is up with browser control enabled, or re-pair.",
    );
  });

  it("includes a server reason for a never-opened failure when present", () => {
    expect(
      relayStatusLabel({
        state: "error",
        relayHost: "host:1",
        lastError: { wasOpen: false, reason: "timed out connecting" },
      }),
    ).toBe("Can't reach the relay at host:1 — timed out connecting.");
  });

  it("treats an opened-then-1008 close as an auth rejection", () => {
    expect(
      relayStatusLabel({
        state: "error",
        relayHost: "host:1",
        lastError: { wasOpen: true, code: 1008 },
      }),
    ).toContain("Unpair, then pair again.");
  });

  it("treats a non-1008 opened close as a drop, even with an auth-sounding reason", () => {
    expect(
      relayStatusLabel({
        state: "error",
        relayHost: "host:1",
        lastError: { wasOpen: true, code: 4001, reason: "token invalid" },
      }),
    ).toBe("Relay dropped by host:1 — token invalid (4001). Reconnecting…");
  });

  it("reports an opened-then-dropped close as reconnecting, with the code", () => {
    expect(
      relayStatusLabel({
        state: "error",
        relayHost: "127.0.0.1:18789",
        lastError: { wasOpen: true, code: 1001, reason: "relay stopped" },
      }),
    ).toBe("Relay dropped by 127.0.0.1:18789 — relay stopped (1001). Reconnecting…");
  });

  it("falls back to 'the gateway' when no relayHost is known", () => {
    expect(relayStatusLabel({ state: "error", lastError: { wasOpen: false } })).toContain(
      "Can't reach the relay at the gateway.",
    );
  });
});
