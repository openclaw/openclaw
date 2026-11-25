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
  it.each([
    ["external-native", { ok: true, status: 200 }],
    [
      "container",
      {
        ok: false,
        status: 200,
        error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
      },
    ],
  ] as const)("probes only the configured %s endpoint", async (transportKind, result) => {
    if (transportKind === "container") {
      containerCheck.mockResolvedValue(result);
    } else {
      nativeCheck.mockResolvedValue(result);
    }
    const baseUrl = `http://${transportKind === "container" ? "container" : "native"}:8080`;
    await expect(
      signalCheck(baseUrl, 5_000, { transportKind, account: "+15550001111" }),
    ).resolves.toEqual(result);
    if (transportKind === "container") {
      expect(containerCheck).toHaveBeenCalledWith(baseUrl, 5_000, "+15550001111");
      expect(nativeCheck).not.toHaveBeenCalled();
    } else {
      expect(nativeCheck).toHaveBeenCalledWith(baseUrl, 5_000);
      expect(containerCheck).not.toHaveBeenCalled();
    }
  });
});

describe("streamSignalEvents", () => {
  it.each(["managed-native", "container"] as const)(
    "streams and converts %s events",
    async (transportKind) => {
      if (transportKind === "container") {
        containerStream.mockImplementation(async (params) => {
          params.onEvent({ envelope: { sourceNumber: "+15555550124" } });
        });
      } else {
        nativeStream.mockImplementation(async (params) => {
          params.onEvent({ event: "receive", data: "native" });
        });
      }
      const onEvent = vi.fn();
      const params = {
        baseUrl: "http://localhost:8080",
        account: "+15555550123",
        timeoutMs: transportKind === "container" ? undefined : 0,
        onStreamOpen: vi.fn(),
      };
      await streamSignalEvents({ ...params, transportKind, onEvent });
      const selected = transportKind === "container" ? containerStream : nativeStream;
      const unused = transportKind === "container" ? nativeStream : containerStream;
      expect(selected).toHaveBeenCalledWith(expect.objectContaining(params));
      if (transportKind !== "container") {
        expect(nativeStream.mock.calls[0]?.[0].onEvent).toBe(onEvent);
      }
      expect(onEvent).toHaveBeenCalledWith({
        event: "receive",
        data:
          transportKind === "container"
            ? JSON.stringify({ envelope: { sourceNumber: "+15555550124" } })
            : "native",
      });
      expect(unused).not.toHaveBeenCalled();
    },
  );
});
