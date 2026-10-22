import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalCheck, streamSignalEvents } from "./client-adapter.js";
import * as containerClient from "./client-container.js";
import * as nativeClient from "./client.js";

const nativeCheck = vi.fn<typeof nativeClient.signalCheck>();
const nativeStream = vi.fn<typeof nativeClient.streamSignalEvents>();
const containerCheck = vi.fn<typeof containerClient.containerCheck>();
const containerStream = vi.fn<typeof containerClient.streamContainerEvents>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(nativeClient, "signalCheck").mockImplementation(nativeCheck);
  vi.spyOn(nativeClient, "streamSignalEvents").mockImplementation(nativeStream);
  vi.spyOn(containerClient, "containerCheck").mockImplementation(containerCheck);
  vi.spyOn(containerClient, "streamContainerEvents").mockImplementation(containerStream);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signalCheck", () => {
  it("probes only the configured native endpoint", async () => {
    nativeCheck.mockResolvedValue({ ok: true, status: 200 });

    await expect(
      signalCheck("http://native:8080", 5_000, { transportKind: "external-native" }),
    ).resolves.toEqual({ ok: true, status: 200 });
    expect(nativeCheck).toHaveBeenCalledWith("http://native:8080", 5_000);
    expect(containerCheck).not.toHaveBeenCalled();
  });

  it("validates the configured container account's receive WebSocket", async () => {
    const result = {
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    };
    containerCheck.mockResolvedValue(result);

    await expect(
      signalCheck("http://container:8080", 5_000, {
        transportKind: "container",
        account: "+15550001111",
      }),
    ).resolves.toEqual(result);
    expect(containerCheck).toHaveBeenCalledWith("http://container:8080", 5_000, "+15550001111");
    expect(nativeCheck).not.toHaveBeenCalled();
  });
});

describe("streamSignalEvents", () => {
  it("uses native SSE for managed and external native transports", async () => {
    nativeStream.mockImplementation(async (params) => {
      params.onEvent({ event: "receive", data: "native" });
    });
    const onEvent = vi.fn();
    const onStreamOpen = vi.fn();

    const params = {
      baseUrl: "http://native:8080",
      account: "+15555550123",
      timeoutMs: 0,
      onEvent,
      onStreamOpen,
    };
    await streamSignalEvents({ ...params, transportKind: "managed-native" });

    expect(nativeStream).toHaveBeenCalledWith(expect.objectContaining(params));
    expect(onEvent).toHaveBeenCalledWith({ event: "receive", data: "native" });
    expect(containerStream).not.toHaveBeenCalled();
  });

  it("forwards an undefined container timeout and converts its event shape", async () => {
    containerStream.mockImplementation(async (params) => {
      params.onEvent({ envelope: { sourceNumber: "+15555550124" } });
    });
    const onEvent = vi.fn();
    const onStreamOpen = vi.fn();

    const params = {
      baseUrl: "http://container:8080",
      account: "+15555550123",
      timeoutMs: undefined,
      onStreamOpen,
    };
    await streamSignalEvents({ ...params, transportKind: "container", onEvent });

    expect(containerStream).toHaveBeenCalledWith(expect.objectContaining(params));
    expect(onEvent).toHaveBeenCalledWith({
      event: "receive",
      data: JSON.stringify({ envelope: { sourceNumber: "+15555550124" } }),
    });
    expect(nativeStream).not.toHaveBeenCalled();
  });
});
