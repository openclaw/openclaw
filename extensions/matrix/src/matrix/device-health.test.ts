// Matrix tests cover device health plugin behavior.
import { describe, expect, it } from "vitest";
import { summarizeMatrixDeviceHealth } from "./device-health.js";

describe("matrix device health", () => {
  it("summarizes stale OpenClaw-managed devices separately from the current device", () => {
    const devices = [
      {
        deviceId: "du314Zpw3A",
        displayName: "OpenClaw Gateway",
        current: true,
      },
      {
        deviceId: "BritdXC6iL",
        displayName: "OpenClaw Gateway",
        current: false,
      },
      {
        deviceId: "G6NJU9cTgs",
        displayName: "OpenClaw Debug",
        current: false,
      },
      {
        deviceId: "phone123",
        displayName: "Element iPhone",
        current: false,
      },
      { deviceId: "unnamed", displayName: null, current: false },
    ];

    expect(summarizeMatrixDeviceHealth(devices)).toEqual({
      currentDeviceId: "du314Zpw3A",
      currentOpenClawDevices: [devices[0]],
      staleOpenClawDevices: [devices[1], devices[2]],
    });
  });
});
