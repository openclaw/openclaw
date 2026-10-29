import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");

afterEach(() => {
  connectOverCdpSpy.mockReset();
});

function mockPageInitializationFailure(
  wire: import("playwright-core").ConnectOverCDPTransport,
  sessionId: string,
  targetId: string,
  transition?: () => void,
) {
  connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
    const transport = value as import("playwright-core").ConnectOverCDPTransport;
    wire.onmessage?.({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: { targetId, type: "page", browserContextId: "default-context" },
      },
    });
    transport.send({ id: 7, method: "Runtime.enable", sessionId });
    transition?.();
    const error = new Error("Timeout 1000ms exceeded");
    error.name = "TimeoutError";
    throw error;
  }) as never);
}

describe("Playwright CDP initialization diagnostics", () => {
  it("identifies the page target whose initialization blocks a cold connection", async () => {
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: closeWire,
    };
    mockPageInitializationFailure(wire, "stalled-session", "STALLED-PAGE");

    const connection = connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 1000,
      headers: {},
      preparedTransport: wire,
    });
    await expect(connection).rejects.toThrow(
      'page target "STALLED-PAGE" did not respond during initialization',
    );
    await expect(connection).rejects.toThrow(
      "Close the target in the browser or provider dashboard",
    );
    expect(closeWire).toHaveBeenCalledOnce();
  });

  it("forgets unanswered commands when their page session detaches", async () => {
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: vi.fn(),
    };
    mockPageInitializationFailure(wire, "detached-session", "DETACHED-PAGE", () => {
      wire.onmessage?.({
        method: "Target.detachedFromTarget",
        params: { sessionId: "detached-session" },
      });
    });

    await expect(
      connectOverCdpTransport("http://127.0.0.1:18799", {
        timeout: 1000,
        headers: {},
        preparedTransport: wire,
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded");
  });

  it("does not blame a target whose initialization command completed", async () => {
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: vi.fn(),
    };
    mockPageInitializationFailure(wire, "healthy-session", "HEALTHY-PAGE", () => {
      wire.onmessage?.({ id: 7, result: {} });
    });

    await expect(
      connectOverCdpTransport("http://127.0.0.1:18799", {
        timeout: 1000,
        headers: {},
        preparedTransport: wire,
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded");
  });
});
