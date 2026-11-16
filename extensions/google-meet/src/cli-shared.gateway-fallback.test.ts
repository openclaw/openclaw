import { AsyncWorkScope } from "openclaw/plugin-sdk/concurrency-runtime";
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
    ).resolves.toEqual({ ok: false });
  });

  it("falls back when the exact Meet method is not registered", async () => {
    const error = gatewayRequestError("unknown method: googlemeet.status");
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockRejectedValue(error);

    await expect(
      callGoogleMeetGateway({
        method: "googlemeet.status",
      }),
    ).resolves.toEqual({ ok: false });
  });

  it.each([
    gatewayTransportError(1006),
    Object.assign(gatewayTransportError(), { kind: "timeout" }),
    gatewayRequestError("unknown method: voicecall.status"),
    new Error("unknown method: googlemeet.status"),
  ])("propagates a non-fallback error: $message $kind", async (error) => {
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockRejectedValue(error);
    await expect(
      callGoogleMeetGateway({
        method: "googlemeet.status",
      }),
    ).rejects.toBe(error);
  });

  it("rejects instead of falling back or returning a reply after Ctrl+C", async () => {
    const work = new AsyncWorkScope();
    const call = vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(async () => {
      work.beginClose();
      throw gatewayTransportError();
    });
    await expect(
      work.run(() => callGoogleMeetGateway({ method: "googlemeet.transcript" })),
    ).rejects.toThrow();
    expect(call.mock.calls[0]?.[3]).toEqual({ progress: false, signal: expect.any(AbortSignal) });
  });
});
