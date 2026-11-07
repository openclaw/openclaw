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
  it("accepts bounded queue-read unavailability without exposing raw errors", () => {
    const snapshot = snapshotWithPresence({ ts: 1 });
    const withQueues = (deliveryQueues: Record<string, unknown>) => ({
      ...snapshot,
      health: { deliveryQueues },
    });
    expect(Value.Check(SnapshotSchema, withQueues({ failed: [], unavailable: ["outbound"] }))).toBe(
      true,
    );
    expect(
      Value.Check(SnapshotSchema, withQueues({ failed: [], unavailable: ["private-error"] })),
    ).toBe(false);
    expect(
      Value.Check(
        SnapshotSchema,
        withQueues({ failed: [], unavailable: ["outbound"], error: "private-error" }),
      ),
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
