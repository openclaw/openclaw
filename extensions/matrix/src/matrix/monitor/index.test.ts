import { describe, expect, it } from "vitest";
import { DEFAULT_STARTUP_GRACE_MS, isConfiguredMatrixRoomEntry } from "./index.js";

describe("monitorMatrixProvider helpers", () => {
  it("treats !-prefixed room IDs as configured room entries", () => {
    expect(isConfiguredMatrixRoomEntry("!abc123")).toBe(true);
    expect(isConfiguredMatrixRoomEntry("!RoomMixedCase")).toBe(true);
  });

  it("requires a homeserver suffix for # aliases", () => {
    expect(isConfiguredMatrixRoomEntry("#alias:example.org")).toBe(true);
    expect(isConfiguredMatrixRoomEntry("#alias")).toBe(false);
  });

  it("uses a non-zero startup grace window", () => {
    expect(DEFAULT_STARTUP_GRACE_MS).toBe(5000);
  });
});
