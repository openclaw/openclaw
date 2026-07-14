// Line tests cover group history plugin behavior.
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { describe, expect, it } from "vitest";
import { clearConsumedLineGroupHistory, snapshotLineGroupHistory } from "./group-history.js";

const entry = (messageId: string, body: string, timestamp: number): HistoryEntry => ({
  sender: "user:U1",
  body,
  timestamp,
  messageId,
});

describe("snapshotLineGroupHistory", () => {
  it("reads the window and captures the identity keys of exactly the read entries", () => {
    const map = new Map([["G", [entry("m1", "a", 1), entry("m2", "b", 2)]]]);

    const { inboundHistory, consumedKeys } = snapshotLineGroupHistory(map, "G", 10);

    expect(inboundHistory).toEqual([entry("m1", "a", 1), entry("m2", "b", 2)]);
    expect(consumedKeys).toEqual(new Set(["m1", "m2"]));
  });

  it("consumes only the entries inside the window limit", () => {
    const map = new Map([["G", [entry("m1", "a", 1), entry("m2", "b", 2), entry("m3", "c", 3)]]]);

    const { inboundHistory, consumedKeys } = snapshotLineGroupHistory(map, "G", 2);

    expect(inboundHistory).toEqual([entry("m2", "b", 2), entry("m3", "c", 3)]);
    expect(consumedKeys).toEqual(new Set(["m2", "m3"]));

    // Cleanup drops only what the turn read; the entry outside the window stays.
    clearConsumedLineGroupHistory(map, "G", consumedKeys);
    expect(map.get("G")).toEqual([entry("m1", "a", 1)]);
  });

  it("returns an empty snapshot without a map, key, or positive limit", () => {
    expect(snapshotLineGroupHistory(undefined, "G", 10)).toEqual({});
    expect(snapshotLineGroupHistory(new Map(), undefined, 10)).toEqual({});
    expect(snapshotLineGroupHistory(new Map([["G", [entry("m1", "a", 1)]]]), "G", 0)).toEqual({});
  });
});

describe("clearConsumedLineGroupHistory", () => {
  it("keeps entries recorded after the snapshot and drops the consumed ones", () => {
    const map = new Map([["G", [entry("m1", "a", 1), entry("m2", "b", 2)]]]);
    const { consumedKeys } = snapshotLineGroupHistory(map, "G", 10);
    // A concurrent message arrives after the snapshot was taken.
    map.get("G")?.push(entry("m3", "c", 3));

    clearConsumedLineGroupHistory(map, "G", consumedKeys);

    expect(map.get("G")).toEqual([entry("m3", "c", 3)]);
  });

  it("deletes the key when every entry was consumed", () => {
    const map = new Map([["G", [entry("m1", "a", 1)]]]);
    const { consumedKeys } = snapshotLineGroupHistory(map, "G", 10);

    clearConsumedLineGroupHistory(map, "G", consumedKeys);

    expect(map.has("G")).toBe(false);
  });

  it("no-ops without consumed keys", () => {
    const map = new Map([["G", [entry("m1", "a", 1)]]]);

    clearConsumedLineGroupHistory(map, "G", undefined);

    expect(map.get("G")).toHaveLength(1);
  });

  it("falls back to timestamp/sender/body identity when messageId is absent", () => {
    const legacy: HistoryEntry = { sender: "user:U1", body: "x", timestamp: 5 };
    const map = new Map([["G", [legacy]]]);
    const { consumedKeys } = snapshotLineGroupHistory(map, "G", 10);

    clearConsumedLineGroupHistory(map, "G", consumedKeys);

    expect(map.has("G")).toBe(false);
  });
});
