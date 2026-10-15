import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGoogleMeetGateway } from "./cli-shared.js";

function gatewayTransportError(code?: number): Error {
  return Object.assign(new Error("gateway transport failed"), {
    name: "GatewayTransportError",
    kind: "closed",
    connectionDetails: { url: "ws://127.0.0.1:18789" },
    ...(code === undefined ? {} : { code }),
  });
}

function gatewayRequestError(message: string, gatewayCode = "INVALID_REQUEST"): Error {
  return Object.assign(new Error(message), {
    name: "GatewayClientRequestError",
    gatewayCode,
    retryable: false,
  });
}

describe("callGoogleMeetGateway local fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back for an uncoded transport close", async () => {
    const error = gatewayTransportError();
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockRejectedValue(error);

    await expect(
      callGoogleMeetGateway({
        method: "googlemeet.status",
      }),
    ).resolves.toEqual({ ok: false, error });
  });

  it("propagates an uncoded close when a remote Gateway is configured", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "ws://gateway.example:18789");
    const error = gatewayTransportError();

    try {
      await expect(
        callGoogleMeetGateway({
          callGateway: rejectingGateway(error),
          method: "googlemeet.status",
        }),
      ).rejects.toBe(error);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("propagates a coded transport close", async () => {
    const error = gatewayTransportError(1006);
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockRejectedValue(error);

    await expect(
      callGoogleMeetGateway({
        method: "googlemeet.status",
      }),
    ).rejects.toBe(error);
  });

  it("propagates a transport timeout", async () => {
    const error = Object.assign(new Error("gateway timed out"), {
      name: "GatewayTransportError",
      kind: "timeout",
      connectionDetails: { url: "ws://127.0.0.1:18789" },
    });
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockRejectedValue(error);

    await expect(
      callGoogleMeetGateway({
        method: "googlemeet.status",
      }),
    ).rejects.toBe(error);
  });

  it("falls back when the exact Meet method is not registered", async () => {
    const error = gatewayRequestError("unknown method: googlemeet.status");
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockRejectedValue(error);

    await expect(
      callGoogleMeetGateway({
        method: "googlemeet.status",
      }),
    ).resolves.toEqual({ ok: false, error });
  });

  it.each([
    gatewayRequestError("unknown method: voicecall.status"),
    new Error("unknown method: googlemeet.status"),
  ])("propagates a non-fallback error: $message", async (error) => {
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockRejectedValue(error);
    await expect(
      callGoogleMeetGateway({
        method: "googlemeet.status",
      }),
    ).rejects.toBe(error);
  });
});
