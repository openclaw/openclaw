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

  it("validates runtime-config health diagnostics", () => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      health: {
        runtimeConfig: {
          state: "drift",
          liveDefaultModel: "openai/gpt-5.6-sol",
          observedDefaultModel: "openai/gpt-5.6-terra",
          driftPaths: ["agents.defaults.model"],
          message: "Runtime config differs from the latest completed reload observation.",
        },
      },
    };

    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(SnapshotSchema, {
        ...snapshot,
        health: { runtimeConfig: { state: "stale" } },
      }),
    ).toBe(false);
    expect(
      Value.Check(SnapshotSchema, {
        ...snapshot,
        health: { runtimeConfig: { state: "ok", liveSourceFingerprint: "private" } },
      }),
    ).toBe(false);
    expect(
      Value.Check(SnapshotSchema, {
        ...snapshot,
        health: { runtimeConfig: { state: "ok", diskDefaultModel: "legacy" } },
      }),
    ).toBe(false);
  });
});
