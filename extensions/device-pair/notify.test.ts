import { describe, expect, it } from "vitest";
import { coercePendingPairingRequests } from "./notify.js";

describe("coercePendingPairingRequests", () => {
  it("returns empty array for non-array payloads", () => {
    expect(coercePendingPairingRequests(undefined)).toEqual([]);
    expect(coercePendingPairingRequests(null)).toEqual([]);
    expect(coercePendingPairingRequests({ pending: [] })).toEqual([]);
  });

  it("keeps only well-formed pending entries", () => {
    expect(
      coercePendingPairingRequests([
        { requestId: "r1", deviceId: "d1", displayName: "Phone" },
        { requestId: "r2" },
        { deviceId: "d3" },
        null,
      ]),
    ).toEqual([{ requestId: "r1", deviceId: "d1", displayName: "Phone" }]);
  });
});
