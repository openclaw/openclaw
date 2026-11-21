import assert from "node:assert/strict";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { createKitesurfCdpNormalizer } from "./engines/kitesurf-cdp.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn<(transport: ConnectOverCDPTransport) => Promise<Browser>>(),
}));
vi.mock("./playwright-core.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./playwright-core.runtime.js")>()),
  getPlaywrightCore: () => ({ chromium: { connectOverCDP: connectMock } }),
}));
afterEach(() => {
  vi.useRealTimers();
  connectMock.mockReset();
});

const attach = {
  id: 10,
  method: "Target.attachToTarget",
  sessionId: "browser-session",
  params: { targetId: "page-one", flatten: true },
};
const event = {
  method: "Target.attachedToTarget",
  params: {
    sessionId: "auxiliary",
    targetInfo: { targetId: "page-one", type: "page", browserContextId: "default" },
  },
};

it.each(["chromium", "kitesurf"] as const)(
  "routes auxiliary attachment events only for Kitesurf (%s)",
  async (engine) => {
    vi.useFakeTimers();
    const received: object[] = [];
    const wire: ConnectOverCDPTransport = { send: vi.fn(), close: vi.fn() };
    connectMock.mockResolvedValue({} as Browser);
    await connectOverCdpTransport("ws://127.0.0.1:9222", {
      engine,
      headers: {},
      timeout: 1000,
      preparedTransport: wire,
    });
    const client = connectMock.mock.calls[0]?.[0];
    assert(client);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright transport callback.
    client.onmessage = (message) => received.push(message);
    client.send(attach);
    wire.onmessage?.(event);
    const reply = { id: 10, sessionId: "browser-session", result: { sessionId: "auxiliary" } };
    wire.onmessage?.(reply);
    const detached = {
      method: "Target.detachedFromTarget",
      params: { sessionId: "auxiliary", targetId: "page-one" },
    };
    wire.onmessage?.(detached);
    await vi.runAllTimersAsync();
    expect(received).toEqual(
      engine === "kitesurf"
        ? [
            { ...event, sessionId: "browser-session" },
            reply,
            { ...detached, sessionId: "browser-session" },
          ]
        : [event, reply, detached],
    );
  },
);

it("preserves automatic and already-routed attachments and retires failed requests", () => {
  const normalize = createKitesurfCdpNormalizer();
  expect(normalize.receive(event)).toEqual([event]);
  normalize.send(attach);
  const routed = { ...event, sessionId: "engine-parent" };
  expect(normalize.receive(routed)).toEqual([routed]);
  const error = { id: 10, error: { message: "target closed" }, sessionId: "browser-session" };
  expect(normalize.receive(error)).toEqual([error]);
  expect(normalize.receive(event)).toEqual([event]);
  normalize.send(attach);
  normalize.clear();
  expect(normalize.receive(event)).toEqual([event]);
});

it("bounds unanswered attachment state", () => {
  const normalize = createKitesurfCdpNormalizer();
  for (let id = 0; id < 4096; id++) {
    normalize.send({ ...attach, id });
  }
  expect(() => normalize.send({ ...attach, id: 4096 })).toThrow("too many unanswered");
  normalize.receive({ id: 0, error: { message: "closed" } });
  expect(() => normalize.send({ ...attach, id: 4096 })).not.toThrow();
});

it("resolves page target info and retires explicitly detached sessions", () => {
  const normalize = createKitesurfCdpNormalizer();
  normalize.send(attach);
  normalize.receive(event);
  normalize.receive({ id: 10, result: { sessionId: "auxiliary" } });
  const info = { id: 11, method: "Target.getTargetInfo", sessionId: "auxiliary" };
  expect(normalize.send(info)).toEqual({ ...info, params: { targetId: "page-one" } });
  const explicit = { ...info, params: { targetId: "other-page" } };
  expect(normalize.send(explicit)).toBe(explicit);
  const detach = {
    id: 12,
    method: "Target.detachFromTarget",
    sessionId: "browser-session",
    params: { sessionId: "auxiliary" },
  };
  normalize.send(detach);
  normalize.receive({ id: 12, result: {} });
  expect(normalize.send(info)).toBe(info);
});
