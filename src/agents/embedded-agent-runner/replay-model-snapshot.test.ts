import { describe, expect, it } from "vitest";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import {
  isOwnedTranscriptPayload,
  markOwnedTranscriptPayload,
} from "../../shared/transcript-payload-ownership.js";
import {
  isSameModelSnapshot,
  MODEL_SNAPSHOT_CUSTOM_TYPE,
  readModelSnapshotStateFromEntries,
  type ModelSnapshotEntry,
} from "./replay-model-snapshot.js";

const snapshot = (data: ModelSnapshotEntry) => ({
  type: "custom",
  customType: MODEL_SNAPSHOT_CUSTOM_TYPE,
  data,
});

describe("model snapshot data scan", () => {
  it("retains exact snapshot payloads and the latest finite switch rather than repeat timestamps", () => {
    const first = freezeJsonSnapshot({ timestamp: 1, provider: "first", modelId: "one" });
    const switched = freezeJsonSnapshot({ timestamp: 2, provider: "second", modelId: "two" });
    const repeated = freezeJsonSnapshot({ ...switched, timestamp: 3 });
    markOwnedTranscriptPayload(repeated);
    const state = readModelSnapshotStateFromEntries([
      { type: "custom", customType: "unrelated", data: { timestamp: 9, provider: "ignored" } },
      snapshot(first),
      snapshot(switched),
      snapshot(repeated),
    ]);
    expect(state.lastSnapshot).toBe(repeated);
    expect(Object.isFrozen(state.lastSnapshot)).toBe(true);
    expect(isOwnedTranscriptPayload(state.lastSnapshot!)).toBe(true);
    expect(state.latestSwitchTimestamp).toBe(2);
    expect(readModelSnapshotStateFromEntries([snapshot(first)])).toEqual({
      lastSnapshot: first,
      latestSwitchTimestamp: null,
    });
  });

  it("preserves legacy invalid-data handling without resetting a recorded switch", () => {
    const invalidTimestamp = { timestamp: Number.NaN, provider: "third" };
    const state = readModelSnapshotStateFromEntries([
      snapshot({ timestamp: 1, provider: "first" }),
      snapshot({ timestamp: 2, provider: "second" }),
      snapshot(invalidTimestamp),
      { type: "custom", customType: MODEL_SNAPSHOT_CUSTOM_TYPE, data: null },
      { type: "custom", customType: MODEL_SNAPSHOT_CUSTOM_TYPE, data: "invalid" },
    ]);
    expect(state.lastSnapshot).toBe(invalidTimestamp);
    expect(state.latestSwitchTimestamp).toBe(2);
    expect(readModelSnapshotStateFromEntries([])).toEqual({
      lastSnapshot: null,
      latestSwitchTimestamp: null,
    });
  });

  it("compares only route identity, retaining the existing null/absent/empty equivalence", () => {
    const empty = { timestamp: 1, provider: "", modelApi: "", modelId: "" };
    expect(isSameModelSnapshot(empty, { timestamp: 2, modelApi: null })).toBe(true);
    expect(isSameModelSnapshot(empty, { timestamp: 1, provider: "other" })).toBe(false);
    expect(isSameModelSnapshot(empty, { timestamp: 1, modelApi: "other" })).toBe(false);
    expect(isSameModelSnapshot(empty, { timestamp: 1, modelId: "other" })).toBe(false);
  });
});
