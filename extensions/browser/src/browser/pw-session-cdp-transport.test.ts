import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectOverCdpTransport,
  reattachRelayPage,
  RelayPageRecoveryTimeoutError,
} from "./pw-session-cdp-transport.js";

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

async function connectDeferredRelay(
  wire: import("playwright-core").ConnectOverCDPTransport,
  browser: import("playwright-core").Browser,
  assertCurrent = vi.fn(),
) {
  connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
    const transport = value as import("playwright-core").ConnectOverCDPTransport;
    transport.send({
      id: 41,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    });
    wire.onmessage?.({ id: 41, result: {} });
    wire.onmessage?.({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "old-session",
        targetInfo: { targetId: "BUSY", type: "page", browserContextId: "default-context" },
      },
    });
    return browser;
  }) as never);
  const connection = connectOverCdpTransport("http://127.0.0.1:18799", {
    timeout: 1000,
    headers: {},
    preparedTransport: wire,
    deferInitialAutoAttach: true,
    assertCurrent,
  });
  return { browser: await connection, assertCurrent };
}

describe("Playwright CDP initialization diagnostics", () => {
  it("reattaches one selected relay target on the existing transport and coalesces callers", async () => {
    const sendWire = vi.fn((_message: object) => {});
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: sendWire,
      close: closeWire,
    };
    const browser = { close: vi.fn() } as unknown as import("playwright-core").Browser;
    const connected = await connectDeferredRelay(wire, browser);

    // A metadata lookup attaches a nested session for the same native target.
    // It must not replace the root session that owns Playwright's Page.
    wire.onmessage?.({
      method: "Target.attachedToTarget",
      sessionId: "metadata-parent",
      params: {
        sessionId: "metadata-session",
        targetInfo: { targetId: "BUSY", type: "page", browserContextId: "default-context" },
      },
    });
    wire.onmessage?.({
      method: "Target.detachedFromTarget",
      sessionId: "metadata-parent",
      params: { sessionId: "metadata-session" },
    });
    await expect(reattachRelayPage(browser, "BUSY", 1000, true)).resolves.toBe(false);

    const first = reattachRelayPage(browser, "BUSY", 1000);
    const second = reattachRelayPage(browser, "BUSY", 1000);
    const commands = vi.mocked(sendWire).mock.calls.map(
      ([message]) =>
        message as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        },
    );
    const detach = commands.find((command) => command.method === "Target.detachFromTarget");
    expect(detach).toMatchObject({ params: { sessionId: "old-session" } });
    expect(commands.filter((command) => command.method === "Target.detachFromTarget")).toHaveLength(
      1,
    );
    wire.onmessage?.({
      method: "Target.detachedFromTarget",
      params: { sessionId: "old-session" },
    });
    wire.onmessage?.({ id: detach!.id, result: {} });
    await Promise.resolve();
    const attach = vi
      .mocked(sendWire)
      .mock.calls.map(([message]) => message as { id: number; method: string; params?: object })
      .find((command) => command.method === "Target.attachToTarget");
    expect(attach).toMatchObject({ params: { targetId: "BUSY", flatten: true } });
    wire.onmessage?.({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "new-session",
        targetInfo: { targetId: "BUSY", type: "page", browserContextId: "default-context" },
      },
    });
    wire.onmessage?.({ id: attach!.id, result: { sessionId: "new-session" } });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(connected.assertCurrent).toHaveBeenCalled();
    expect(closeWire).not.toHaveBeenCalled();
    expect(connectOverCdpSpy).toHaveBeenCalledOnce();
  });

  it("rejects CDP errors and can continue after detach succeeds but attach times out", async () => {
    const sendWire = vi.fn((_message: object) => {});
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: sendWire,
      close: closeWire,
    };
    const browser = { close: vi.fn() } as unknown as import("playwright-core").Browser;
    await connectDeferredRelay(wire, browser);
    const recovery = reattachRelayPage(browser, "BUSY", 10);
    const detach = vi
      .mocked(sendWire)
      .mock.calls.map(([message]) => message as { id: number; method: string })
      .find((command) => command.method === "Target.detachFromTarget");
    wire.onmessage?.({
      id: detach!.id,
      error: { message: "Target session retired" },
    });
    await expect(recovery).rejects.toThrow("Target session retired");
    expect(closeWire).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const timedOut = reattachRelayPage(browser, "BUSY", 10);
    const timedOutResult = expect(timedOut).rejects.toBeInstanceOf(RelayPageRecoveryTimeoutError);
    const secondDetach = vi
      .mocked(sendWire)
      .mock.calls.map(([message]) => message as { id: number; method: string; params?: object })
      .findLast((command) => command.method === "Target.detachFromTarget")!;
    wire.onmessage?.({
      method: "Target.detachedFromTarget",
      params: { sessionId: "old-session" },
    });
    wire.onmessage?.({ id: secondDetach.id, result: {} });
    await vi.advanceTimersByTimeAsync(10);
    await timedOutResult;

    const retry = reattachRelayPage(browser, "BUSY", 1000, true);
    const commands = vi
      .mocked(sendWire)
      .mock.calls.map(([message]) => message as { id: number; method: string; params?: object });
    expect(commands.filter((command) => command.method === "Target.detachFromTarget")).toHaveLength(
      2,
    );
    const attach = commands.findLast((command) => command.method === "Target.attachToTarget")!;
    wire.onmessage?.({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "recovered-session",
        targetInfo: { targetId: "BUSY", type: "page", browserContextId: "default-context" },
      },
    });
    wire.onmessage?.({ id: attach.id, result: { sessionId: "recovered-session" } });
    await expect(retry).resolves.toBe(true);
    vi.useRealTimers();
  });

  it.each([
    { mode: "generic", defer: false, fail: false, rejectReplay: false },
    { mode: "borrowed relay", defer: true, fail: false, rejectReplay: false },
    { mode: "failed borrowed relay handshake", defer: true, fail: true, rejectReplay: false },
    { mode: "rejected borrowed relay replay", defer: true, fail: false, rejectReplay: true },
  ])("handles initial auto-attach for $mode", async ({ defer, fail, rejectReplay }) => {
    const closeWire = vi.fn();
    const sendWire = vi.fn((message: object) => {
      const command = message as { id?: number };
      if (rejectReplay && typeof command.id === "number" && command.id <= -10_000) {
        wire.onmessage?.({
          id: command.id,
          error: { message: "native attach denied" },
        });
      }
    });
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: sendWire,
      close: closeWire,
    };
    const browser = { close: vi.fn() } as never;
    let playwrightTransport: import("playwright-core").ConnectOverCDPTransport | undefined;
    const originalParams = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page" }],
    };
    connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
      const transport = value as import("playwright-core").ConnectOverCDPTransport;
      playwrightTransport = transport;
      transport.send({ id: 41, method: "Target.setAutoAttach", params: originalParams });
      if (fail) {
        const error = new Error("Timeout 1000ms exceeded");
        error.name = "TimeoutError";
        throw error;
      }
      wire.onmessage?.({ id: 41, result: {} });
      return browser;
    }) as never);

    const connection = connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 1000,
      headers: {},
      preparedTransport: wire,
      deferInitialAutoAttach: defer,
    });
    if (fail) {
      await expect(connection).rejects.toThrow("Timeout 1000ms exceeded");
    } else {
      await expect(connection).resolves.toBe(browser);
      if (!defer) {
        await expect(reattachRelayPage(browser, "BUSY")).resolves.toBe(false);
      }
    }

    expect(sendWire).toHaveBeenCalledTimes(defer && !fail ? 2 : 1);
    expect(sendWire).toHaveBeenNthCalledWith(1, {
      id: 41,
      method: "Target.setAutoAttach",
      params: { ...originalParams, autoAttach: !defer },
    });
    if (defer && !fail) {
      expect(sendWire).toHaveBeenNthCalledWith(2, {
        id: expect.any(Number),
        method: "Target.setAutoAttach",
        params: originalParams,
      });
      expect((sendWire.mock.calls[1]?.[0] as { id: number } | undefined)?.id).toBeLessThan(-9999);
    }
    if (rejectReplay) {
      expect(closeWire).toHaveBeenCalledOnce();
      expect(() => playwrightTransport?.send({ id: 42, method: "Browser.getVersion" })).toThrow(
        "Relay page attachment failed: native attach denied",
      );
    }
  });

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
