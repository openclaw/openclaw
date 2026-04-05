import { describe, expect, it } from "vitest";
import { isMullusiManagedMatrixDevice, summarizeMatrixDeviceHealth } from "./device-health.js";

describe("matrix device health", () => {
  it("detects Mullusi-managed device names", () => {
    expect(isMullusiManagedMatrixDevice("Mullusi Gateway")).toBe(true);
    expect(isMullusiManagedMatrixDevice("Mullusi Debug")).toBe(true);
    expect(isMullusiManagedMatrixDevice("Element iPhone")).toBe(false);
    expect(isMullusiManagedMatrixDevice(null)).toBe(false);
  });

  it("summarizes stale Mullusi-managed devices separately from the current device", () => {
    const summary = summarizeMatrixDeviceHealth([
      {
        deviceId: "du314Zpw3A",
        displayName: "Mullusi Gateway",
        current: true,
      },
      {
        deviceId: "BritdXC6iL",
        displayName: "Mullusi Gateway",
        current: false,
      },
      {
        deviceId: "G6NJU9cTgs",
        displayName: "Mullusi Debug",
        current: false,
      },
      {
        deviceId: "phone123",
        displayName: "Element iPhone",
        current: false,
      },
    ]);

    expect(summary.currentDeviceId).toBe("du314Zpw3A");
    expect(summary.currentMullusiDevices).toEqual([
      expect.objectContaining({ deviceId: "du314Zpw3A" }),
    ]);
    expect(summary.staleMullusiDevices).toEqual([
      expect.objectContaining({ deviceId: "BritdXC6iL" }),
      expect.objectContaining({ deviceId: "G6NJU9cTgs" }),
    ]);
  });
});
