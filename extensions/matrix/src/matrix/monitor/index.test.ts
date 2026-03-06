import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STARTUP_GRACE_MS,
  isConfiguredMatrixRoomEntry,
  requestMatrixOwnDeviceVerification,
} from "./index.js";

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

describe("requestMatrixOwnDeviceVerification", () => {
  it("falls back to sending a to-device verification request to other devices", async () => {
    const sendToDevices = vi.fn(async () => {});
    const result = await requestMatrixOwnDeviceVerification({
      userId: "@bot:example.org",
      client: {
        crypto: { clientDeviceId: "DEVICE_A" },
        getOwnDevices: async () => [
          { device_id: "DEVICE_A" },
          { device_id: "DEVICE_B" },
          { device_id: "DEVICE_C" },
        ],
        sendToDevices,
      },
    });

    expect(result).toBe("requested");
    expect(sendToDevices).toHaveBeenCalledTimes(1);
    expect(sendToDevices).toHaveBeenCalledWith(
      "m.key.verification.request",
      expect.objectContaining({
        "@bot:example.org": {
          DEVICE_B: expect.objectContaining({
            from_device: "DEVICE_A",
            methods: ["m.sas.v1"],
            transaction_id: expect.any(String),
          }),
          DEVICE_C: expect.objectContaining({
            from_device: "DEVICE_A",
            methods: ["m.sas.v1"],
            transaction_id: expect.any(String),
          }),
        },
      }),
    );
  });

  it("returns no-other-devices when only the current device exists", async () => {
    const sendToDevices = vi.fn(async () => {});
    const result = await requestMatrixOwnDeviceVerification({
      userId: "@bot:example.org",
      client: {
        crypto: { clientDeviceId: "DEVICE_A" },
        getOwnDevices: async () => [{ device_id: "DEVICE_A" }],
        sendToDevices,
      },
    });

    expect(result).toBe("no-other-devices");
    expect(sendToDevices).not.toHaveBeenCalled();
  });

  it("uses SDK crypto requestOwnUserVerification when available", async () => {
    const requestOwnUserVerification = vi.fn(async () => ({ id: "request" }));
    const result = await requestMatrixOwnDeviceVerification({
      userId: "@bot:example.org",
      client: {
        crypto: {
          clientDeviceId: "DEVICE_A",
          requestOwnUserVerification,
        },
        getOwnDevices: async () => [],
        sendToDevices: async () => {},
      },
    });

    expect(result).toBe("requested");
    expect(requestOwnUserVerification).toHaveBeenCalledTimes(1);
  });
});
