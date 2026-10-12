// Signal tests cover concrete transport routing in the client adapter.
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
    containerCheck.mockResolvedValue({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });

    await expect(
      signalCheck("http://container:8080", 5_000, {
        transportKind: "container",
        account: "+15550001111",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });
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

    await streamSignalEvents({
      baseUrl: "http://native:8080",
      account: "+15555550123",
      transportKind: "managed-native",
      timeoutMs: 0,
      onEvent,
      onStreamOpen,
    });

    expect(nativeStream).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://native:8080",
        account: "+15555550123",
        timeoutMs: 0,
        onStreamOpen,
      }),
    );
    expect(onEvent).toHaveBeenCalledWith({ event: "receive", data: "native" });
    expect(containerStream).not.toHaveBeenCalled();
  });

  it.each([undefined])(
    "forwards container timeout %s and converts its event shape",
    async (timeoutMs) => {
      containerStream.mockImplementation(async (params) => {
        params.onEvent({ envelope: { sourceNumber: "+15555550124" } });
      });
      const onEvent = vi.fn();
      const onStreamOpen = vi.fn();

      await streamSignalEvents({
        baseUrl: "http://container:8080",
        account: "+15555550123",
        transportKind: "container",
        timeoutMs,
        onEvent,
        onStreamOpen,
      });

      expect(containerStream).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://container:8080",
          account: "+15555550123",
          timeoutMs,
          onStreamOpen,
        }),
      );
      expect(onEvent).toHaveBeenCalledWith({
        event: "receive",
        data: JSON.stringify({ envelope: { sourceNumber: "+15555550124" } }),
      });
      expect(nativeStream).not.toHaveBeenCalled();
    },
  );
});
