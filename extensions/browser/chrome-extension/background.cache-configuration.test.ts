import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

async function setup(accessMode: "all" | "selected") {
  const harness = await loadBackground({
    storedConfig: {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode,
    },
    initialTabs: [{ id: 7, url: "https://example.com/source", groupId: 7, windowId: 1 }],
  });
  const socket = harness.relaySockets[0];
  assert(socket);
  await harness.authenticate(socket);
  let seq = 0;
  const request = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++seq;
      socket.send.mockImplementation((raw) => {
        const frame = JSON.parse(raw);
        if (frame.seq === id) {
          resolve(frame);
        }
      });
      socket.receive({ ...message, seq: id });
    });
  expect(await request({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
  return { ...harness, request };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function commitDocument(harness: Harness) {
  const url = "https://example.com/destination";
  harness.updateTab(7, { url, pendingUrl: undefined });
  harness.debuggerEventListener?.({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "root", loaderId: "destination", url },
  });
  harness.debuggerEventListener?.({ tabId: 7 }, "Page.lifecycleEvent", {
    name: "load",
    frameId: "root",
    loaderId: "destination",
  });
}

async function dispatch(
  harness: Harness,
  method: string,
  params: Record<string, unknown>,
  duringCommand: () => void | Promise<unknown>,
) {
  const native = harness.debuggerSendCommand.getMockImplementation()!;
  harness.debuggerSendCommand.mockImplementation(async (source, command, args) => {
    if (command !== method) {
      return await native(source, command, args);
    }
    await duringCommand();
    return {};
  });
  return await harness.request({ type: "cdp", tabId: 7, method, params });
}

describe.each(["all", "selected"] as const)("network configuration in %s mode", (mode) => {
  it.each([
    { method: "Network.setCacheDisabled", params: { cacheDisabled: true } },
    { method: "Network.setExtraHTTPHeaders", params: { headers: { "X-Test": "synthetic" } } },
    { method: "Network.setBypassServiceWorker", params: { bypass: true } },
  ])(
    "delivers $method after an allowed document commit during dispatch",
    async ({ method, params }) => {
      const harness = await setup(mode);
      expect(await dispatch(harness, method, params, () => commitDocument(harness))).toMatchObject({
        type: "result",
        result: {},
      });
    },
  );

  it("rejects a cache-setting receipt after genuine access revocation", async () => {
    const harness = await setup(mode);
    const response = await dispatch(
      harness,
      "Network.setCacheDisabled",
      { cacheDisabled: true },
      () =>
        sendRuntimeMessage(harness, {
          type: "toggleTabAccess",
          tabId: 7,
          accessMode: mode,
          grant: false,
        }),
    );
    expect(response).toMatchObject({ type: "error" });
    expect(response.result).toBeUndefined();
  });
});

it("rejects a cache-setting receipt after debugger detach", async () => {
  const harness = await setup("selected");
  const response = await dispatch(
    harness,
    "Network.setCacheDisabled",
    { cacheDisabled: true },
    () => harness.debuggerDetachListener?.({ tabId: 7 }, "canceled_by_user"),
  );
  expect(response).toMatchObject({ type: "error" });
  expect(response.result).toBeUndefined();
});

it.each(["Network.getResponseBody", "Fetch.getResponseBody"])(
  "rejects document-sensitive %s after an allowed document commit",
  async (method) => {
    const harness = await setup("selected");
    const response = await dispatch(harness, method, { requestId: "synthetic" }, () =>
      commitDocument(harness),
    );
    expect(response).toMatchObject({ type: "error", message: "tab 7 access was revoked" });
    expect(response.result).toBeUndefined();
  },
);
