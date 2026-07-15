import { describe, expect, it } from "vitest";
import {
  DISCORD_PRESENCE_BURST_LIMIT,
  DISCORD_PRESENCE_BURST_WINDOW_MS,
  DISCORD_PRESENCE_RECONNECT_SUPPRESS_MS,
  DiscordPresenceEmissionGate,
  resolveDiscordPresenceGateOptions,
} from "./presence-emission-gate.js";

const options = resolveDiscordPresenceGateOptions(undefined);

describe("resolveDiscordPresenceGateOptions", () => {
  it("defaults to a five-minute reconnect window and bounded burst", () => {
    expect(options).toEqual({
      reconnectSuppressMs: DISCORD_PRESENCE_RECONNECT_SUPPRESS_MS,
      burstLimit: DISCORD_PRESENCE_BURST_LIMIT,
      burstWindowMs: DISCORD_PRESENCE_BURST_WINDOW_MS,
    });
    expect(DISCORD_PRESENCE_RECONNECT_SUPPRESS_MS).toBe(5 * 60 * 1000);
  });

  it("converts configured seconds and honors zero as disabled", () => {
    expect(
      resolveDiscordPresenceGateOptions({
        reconnectSuppressSeconds: 0,
        burstLimit: 3,
        burstWindowSeconds: 10,
      }),
    ).toEqual({ reconnectSuppressMs: 0, burstLimit: 3, burstWindowMs: 10_000 });
  });
});

describe("DiscordPresenceEmissionGate", () => {
  it("suppresses emission during the reconnect window and logs once", () => {
    const gate = new DiscordPresenceEmissionGate();
    gate.noteGatewaySessionReset(1_000);

    expect(gate.evaluateReconnectWindow(1_001, options)).toEqual({
      allowed: false,
      reason: "reconnect-window",
      shouldLog: true,
    });
    expect(gate.evaluateReconnectWindow(2_000, options)).toEqual({
      allowed: false,
      reason: "reconnect-window",
      shouldLog: false,
    });
    expect(gate.evaluateReconnectWindow(1_000 + options.reconnectSuppressMs, options)).toEqual({
      allowed: true,
    });
  });

  it("logs again for each new reconnect window", () => {
    const gate = new DiscordPresenceEmissionGate();
    gate.noteGatewaySessionReset(0);
    expect(gate.evaluateReconnectWindow(1, options)).toMatchObject({ shouldLog: true });
    gate.noteGatewaySessionReset(options.reconnectSuppressMs * 2);
    expect(
      gate.evaluateReconnectWindow(options.reconnectSuppressMs * 2 + 1, options),
    ).toMatchObject({
      shouldLog: true,
    });
  });

  it("does not suppress when the reconnect window is disabled", () => {
    const gate = new DiscordPresenceEmissionGate();
    gate.noteGatewaySessionReset(1_000);
    expect(gate.evaluateReconnectWindow(1_001, { ...options, reconnectSuppressMs: 0 })).toEqual({
      allowed: true,
    });
  });

  it("rate-limits emission bursts within the sliding window", () => {
    const gate = new DiscordPresenceEmissionGate();
    const burstOptions = { ...options, burstLimit: 2, burstWindowMs: 10_000 };

    expect(gate.reserveBurst(1_000, burstOptions)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst(2_000, burstOptions)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst(3_000, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
    expect(gate.reserveBurst(4_000, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: false,
    });
    // The window drains as old emissions age out; logging re-arms for the next burst.
    expect(gate.reserveBurst(12_500, burstOptions)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst(12_600, burstOptions)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst(12_700, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
  });

  it("releases failed attempts without spending burst capacity", () => {
    const gate = new DiscordPresenceEmissionGate();
    const burstOptions = { ...options, burstLimit: 1 };
    const first = gate.reserveBurst(1_000, burstOptions);

    expect(first.allowed).toBe(true);
    if (!first.allowed) {
      throw new Error("expected burst reservation");
    }
    gate.releaseBurst(first.reservation);

    expect(gate.reserveBurst(1_001, burstOptions)).toMatchObject({ allowed: true });
  });

  it("preserves the sliding burst window across gateway resets", () => {
    const gate = new DiscordPresenceEmissionGate();
    const burstOptions = { ...options, reconnectSuppressMs: 0, burstLimit: 1 };

    expect(gate.reserveBurst(1_000, burstOptions)).toMatchObject({ allowed: true });
    gate.noteGatewaySessionReset(1_001);

    expect(gate.reserveBurst(1_002, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
  });
});
