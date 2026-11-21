import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SnapshotSchema } from "./snapshot.js";

function snapshotWithPresence(presence: Record<string, unknown>) {
  return {
    presence: [presence],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
  };
}

describe("SnapshotSchema", () => {
  it("carries requested and effective Tailscale exposure separately", () => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      tailscaleMode: "off",
      tailscaleExposure: {
        requestedMode: "serve",
        activeMode: "off",
        status: "failed",
        reason: "Serve is disabled.",
      },
    };
    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(SnapshotSchema, {
        ...snapshot,
        tailscaleExposure: { ...snapshot.tailscaleExposure, activeMode: "unknown" },
      }),
    ).toBe(false);
  });
  it("keeps the running Gateway's exposure optional for older Gateways", () => {
    const snapshot = snapshotWithPresence({ ts: 1 });
    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(SnapshotSchema, { ...snapshot, bindHost: "0.0.0.0", tailscaleMode: "off" }),
    ).toBe(true);
    expect(Value.Check(SnapshotSchema, { ...snapshot, tailscaleMode: "public" })).toBe(false);
  });

  it.each(["accepting"])("accepts public suspension phase %s without lease tokens", (phase) => {
    const snapshot = { ...snapshotWithPresence({ ts: 1 }), suspension: { phase } };
    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(SnapshotSchema, {
        ...snapshot,
        suspension: { phase, suspensionId: "private-token" },
      }),
    ).toBe(false);
  });
});
