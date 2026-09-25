import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLightpandaCdpNormalizer } from "./engines/lightpanda-cdp.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));
vi.mock("./playwright-core.runtime.js", () => ({
  getPlaywrightCore: () => ({ chromium: { connectOverCDP: connectMock } }),
}));

afterEach(() => {
  vi.useRealTimers();
  connectMock.mockReset();
});

const attachedPage = {
  method: "Target.attachedToTarget",
  sessionId: "browser-session",
  params: { sessionId: "page-session", targetInfo: { type: "page", targetId: "page-one" } },
};

describe("Lightpanda CDP session routing", () => {
  it("preserves external Chromium download policy on a normal attach-only connection", async () => {
    const session = {
      send: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newBrowserCDPSession: vi.fn().mockResolvedValue(session),
    } as unknown as Browser;
    connectMock.mockResolvedValue(browser);

    await connectOverCdpTransport("ws://127.0.0.1:9222", {
      engine: "chromium",
      headers: {},
      noDefaults: true,
      timeout: 1000,
      preparedTransport: { send: vi.fn(), close: vi.fn() },
    });

    expect(connectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ noDefaults: true }),
    );
    expect(session.send).not.toHaveBeenCalled();
    expect(session.detach).not.toHaveBeenCalled();
  });

  it("resets stale download policy only when the profile explicitly opts in", async () => {
    const session = {
      send: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newBrowserCDPSession: vi.fn().mockResolvedValue(session),
    } as unknown as Browser;
    connectMock.mockResolvedValue(browser);

    await connectOverCdpTransport("ws://127.0.0.1:9222", {
      engine: "chromium",
      headers: {},
      noDefaults: true,
      resetDefaultDownloadBehaviorOnAttach: true,
      timeout: 1000,
      preparedTransport: { send: vi.fn(), close: vi.fn() },
    });

    expect(session.send).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "default",
    });
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it("keeps managed Chromium download defaults unchanged", async () => {
    const browser = {} as Browser;
    connectMock.mockResolvedValue(browser);

    await connectOverCdpTransport("ws://127.0.0.1:9222", {
      engine: "chromium",
      headers: {},
      timeout: 1000,
      preparedTransport: { send: vi.fn(), close: vi.fn() },
    });

    expect(connectMock).toHaveBeenCalledWith(expect.anything(), { timeout: 1000 });
  });

  it("reports when the requested stale-state reset is unsupported", async () => {
    const session = {
      send: vi.fn().mockRejectedValue(new Error("Browser.setDownloadBehavior was not found")),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newBrowserCDPSession: vi.fn().mockResolvedValue(session),
    } as unknown as Browser;
    connectMock.mockResolvedValue(browser);

    await expect(
      connectOverCdpTransport("ws://127.0.0.1:9222", {
        engine: "chromium",
        headers: {},
        noDefaults: true,
        resetDefaultDownloadBehaviorOnAttach: true,
        timeout: 1000,
        preparedTransport: { send: vi.fn(), close: vi.fn() },
      }),
    ).rejects.toThrow("Requested browser download-policy recovery failed");
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it("reports when the requested browser-level session is unsupported", async () => {
    const browser = {
      newBrowserCDPSession: vi
        .fn()
        .mockRejectedValue(new Error("Browser-level sessions are not supported")),
    } as unknown as Browser;
    const close = vi.fn();
    connectMock.mockResolvedValue(browser);

    await expect(
      connectOverCdpTransport("ws://127.0.0.1:9222", {
        engine: "chromium",
        headers: {},
        noDefaults: true,
        resetDefaultDownloadBehaviorOnAttach: true,
        timeout: 1000,
        preparedTransport: { send: vi.fn(), close },
      }),
    ).rejects.toThrow("Requested browser download-policy recovery failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([undefined, "chromium", "lightpanda"] as const)(
    "normalizes the observed protocol defect only for explicit engine %s",
    async (engine) => {
      vi.useFakeTimers();
      const sent: object[] = [];
      const received: object[] = [];
      const wire: ConnectOverCDPTransport = {
        send: (message) => sent.push(message),
        close: vi.fn(),
      };
      let client: ConnectOverCDPTransport | undefined;
      connectMock.mockImplementation(async (transport: ConnectOverCDPTransport) => {
        client = transport;
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright exposes an onmessage transport callback, not EventTarget.
        transport.onmessage = (message) => received.push(message);
        return {} as Browser;
      });
      await connectOverCdpTransport("ws://127.0.0.1:9222", {
        engine,
        headers: {},
        timeout: 1000,
        preparedTransport: wire,
      });
      if (!client) {
        throw new Error("Playwright transport was not connected");
      }
      wire.onmessage?.(attachedPage);
      const syntheticStartup = {
        method: "Target.attachedToTarget",
        params: {
          sessionId: "STARTUP",
          targetInfo: {
            type: "page",
            targetId: "TID-STARTUP",
            browserContextId: "BID-STARTUP",
          },
        },
      };
      wire.onmessage?.(syntheticStartup);
      const command = {
        id: 41,
        method: "Target.getTargetInfo",
        sessionId: "page-session",
      };
      client.send(command);
      const reply = { id: 41, result: { targetInfo: { targetId: "page-one" } } };
      wire.onmessage?.(reply);
      await vi.runAllTimersAsync();
      expect(sent).toEqual([
        engine === "lightpanda" ? { ...command, params: { targetId: "page-one" } } : command,
      ]);
      expect(received).toEqual([
        attachedPage,
        ...(engine === "lightpanda" ? [] : [syntheticStartup]),
        engine === "lightpanda" ? { ...reply, sessionId: "page-session" } : reply,
      ]);
    },
  );

  it("correlates concurrent replies by request and preserves explicit routing", () => {
    const normalize = createLightpandaCdpNormalizer();
    normalize.receive(attachedPage);
    expect(
      normalize.send({
        id: 1,
        method: "Target.getTargetInfo",
        sessionId: "page-session",
        params: { targetId: "explicit-target" },
      }),
    ).toMatchObject({ params: { targetId: "explicit-target" } });
    normalize.send({ id: 2, method: "Target.getTargets", sessionId: "browser-session" });
    expect(normalize.receive({ id: 2, result: {} })).toEqual({
      id: 2,
      result: {},
      sessionId: "browser-session",
    });
    expect(normalize.receive({ id: 1, error: { message: "not found" } })).toEqual({
      id: 1,
      error: { message: "not found" },
      sessionId: "page-session",
    });
    // A duplicate or unsolicited response must never acquire an old session.
    expect(normalize.receive({ id: 1, result: {} })).toEqual({ id: 1, result: {} });
    normalize.send({ id: 3, method: "Target.getTargets", sessionId: "browser-session" });
    expect(normalize.receive({ id: 3, result: {}, sessionId: "engine-session" })).toEqual({
      id: 3,
      result: {},
      sessionId: "engine-session",
    });
  });

  it("forgets detached targets and all state when the connection closes", () => {
    const normalize = createLightpandaCdpNormalizer();
    normalize.receive(attachedPage);
    normalize.receive({
      method: "Target.detachedFromTarget",
      params: { sessionId: "page-session" },
    });
    const command = { id: 1, method: "Target.getTargetInfo", sessionId: "page-session" };
    expect(normalize.send(command)).toBe(command);
    normalize.receive(attachedPage);
    normalize.clear();
    expect(normalize.receive({ id: 1, result: {} })).toEqual({ id: 1, result: {} });
    expect(normalize.send({ ...command, id: 2 })).not.toHaveProperty("params");
  });

  it("bounds unanswered target requests instead of retaining them indefinitely", () => {
    const normalize = createLightpandaCdpNormalizer();
    for (let id = 1; id <= 4096; id += 1) {
      normalize.send({ id, method: "Target.getTargets", sessionId: "browser-session" });
    }
    expect(() =>
      normalize.send({ id: 4097, method: "Target.getTargets", sessionId: "browser-session" }),
    ).toThrow("too many unanswered target commands");
    normalize.receive({ id: 1, result: {} });
    expect(() =>
      normalize.send({ id: 4097, method: "Target.getTargets", sessionId: "browser-session" }),
    ).not.toThrow();
  });
});
