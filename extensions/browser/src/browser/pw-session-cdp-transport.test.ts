import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");

afterEach(() => {
  connectOverCdpSpy.mockReset();
});

describe("Playwright CDP initialization diagnostics", () => {
  it("identifies the page target whose initialization blocks a cold connection", async () => {
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: closeWire,
    };
    connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
      const transport = value as import("playwright-core").ConnectOverCDPTransport;
      wire.onmessage?.({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "stalled-session",
          targetInfo: {
            targetId: "STALLED-PAGE",
            type: "page",
            browserContextId: "default-context",
          },
        },
      });
      transport.send({ id: 7, method: "Runtime.enable", sessionId: "stalled-session" });
      const error = new Error("Timeout 1000ms exceeded");
      error.name = "TimeoutError";
      throw error;
    }) as never);

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
    connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
      const transport = value as import("playwright-core").ConnectOverCDPTransport;
      wire.onmessage?.({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "detached-session",
          targetInfo: {
            targetId: "DETACHED-PAGE",
            type: "page",
            browserContextId: "default-context",
          },
        },
      });
      transport.send({ id: 7, method: "Runtime.enable", sessionId: "detached-session" });
      wire.onmessage?.({
        method: "Target.detachedFromTarget",
        params: { sessionId: "detached-session" },
      });
      const error = new Error("Timeout 1000ms exceeded");
      error.name = "TimeoutError";
      throw error;
    }) as never);

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
    connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
      const transport = value as import("playwright-core").ConnectOverCDPTransport;
      wire.onmessage?.({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "healthy-session",
          targetInfo: {
            targetId: "HEALTHY-PAGE",
            type: "page",
            browserContextId: "default-context",
          },
        },
      });
      transport.send({ id: 7, method: "Runtime.enable", sessionId: "healthy-session" });
      wire.onmessage?.({ id: 7, result: {} });
      const error = new Error("Timeout 1000ms exceeded");
      error.name = "TimeoutError";
      throw error;
    }) as never);

    await expect(
      connectOverCdpTransport("http://127.0.0.1:18799", {
        timeout: 1000,
        headers: {},
        preparedTransport: wire,
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded");
  });
});
