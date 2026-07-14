// Line tests cover group history plugin behavior.
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { describe, expect, it } from "vitest";
import { clearConsumedLineGroupHistory, snapshotLineGroupHistoryKeys } from "./group-history.js";

const entry = (messageId: string, body: string, timestamp: number): HistoryEntry => ({
  sender: "user:U1",
  body,
  timestamp,
  messageId,
});

describe("snapshotLineGroupHistoryKeys", () => {
  it("captures the identity keys of the current entries", () => {
    const map = new Map([["G", [entry("m1", "a", 1), entry("m2", "b", 2)]]]);
    expect(snapshotLineGroupHistoryKeys(map, "G")).toEqual(new Set(["m1", "m2"]));
  });

  it("returns undefined without a map or key", () => {
    expect(snapshotLineGroupHistoryKeys(undefined, "G")).toBeUndefined();
    expect(snapshotLineGroupHistoryKeys(new Map(), undefined)).toBeUndefined();
  });
});

describe("clearConsumedLineGroupHistory", () => {
  it("keeps entries recorded after the snapshot and drops the consumed ones", () => {
    const map = new Map([["G", [entry("m1", "a", 1), entry("m2", "b", 2)]]]);
    const consumed = snapshotLineGroupHistoryKeys(map, "G");
    // A concurrent message arrives after the snapshot was taken.
    map.get("G")?.push(entry("m3", "c", 3));

    clearConsumedLineGroupHistory(map, "G", consumed);

    expect(map.get("G")).toEqual([entry("m3", "c", 3)]);
  });

  it("deletes the key when every entry was consumed", () => {
    const map = new Map([["G", [entry("m1", "a", 1)]]]);
    const consumed = snapshotLineGroupHistoryKeys(map, "G");

    clearConsumedLineGroupHistory(map, "G", consumed);

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
    const consumed = snapshotLineGroupHistoryKeys(map, "G");

    clearConsumedLineGroupHistory(map, "G", consumed);

    expect(map.has("G")).toBe(false);
  });
});
