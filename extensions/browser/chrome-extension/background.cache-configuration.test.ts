import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectRelay, relayConfig } from "./background.lifecycle-test-helpers.js";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  sendRuntimeMessage,
} from "./background.test-harness.js";

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

type Harness = Awaited<ReturnType<typeof loadBackground>>;
async function dispatch(
  accessMode: "all" | "selected",
  duringCommand: (harness: Harness) => void | Promise<unknown>,
  method = "Network.setCacheDisabled",
  params: Record<string, unknown> = { cacheDisabled: true },
) {
  const harness = await loadBackground({
    storedConfig: relayConfig(accessMode),
    initialTabs: [{ id: 7, url: "https://example.com/source", groupId: 7, windowId: 1 }],
  });
  const { request } = await connectRelay(harness);
  expect(await request({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
  const native = harness.debuggerSendCommand.getMockImplementation()!;
  harness.debuggerSendCommand.mockImplementation(async (source, command, args) => {
    if (command !== method) {
      return await native(source, command, args);
    }
    await duringCommand(harness);
    return {};
  });
  return await request({ type: "cdp", tabId: 7, method, params });
}

function expectError(response: Record<string, unknown>, message?: string) {
  expect(response).toMatchObject({ type: "error", ...(message ? { message } : {}) });
  expect(response.result).toBeUndefined();
}

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

describe.each(["all", "selected"] as const)("network configuration in %s mode", (mode) => {
  it.each([
    { method: "Network.setCacheDisabled", params: { cacheDisabled: true } },
    { method: "Network.setExtraHTTPHeaders", params: { headers: { "X-Test": "synthetic" } } },
    { method: "Network.setBypassServiceWorker", params: { bypass: true } },
  ])(
    "delivers $method after an allowed document commit during dispatch",
    async ({ method, params }) => {
      expect(await dispatch(mode, commitDocument, method, params)).toMatchObject({
        type: "result",
        result: {},
      });
    },
  );

  it("rejects a cache-setting receipt after genuine access revocation", async () => {
    const response = await dispatch(mode, (harness) =>
      sendRuntimeMessage(harness, {
        type: "toggleTabAccess",
        tabId: 7,
        accessMode: mode,
        grant: false,
      }),
    );
    expectError(response);
  });
});

it("rejects a cache-setting receipt after debugger detach", async () => {
  const response = await dispatch("selected", (harness) =>
    harness.debuggerDetachListener?.({ tabId: 7 }, "canceled_by_user"),
  );
  expectError(response);
});

it.each(["Network.getResponseBody", "Fetch.getResponseBody"])(
  "rejects document-sensitive %s after an allowed document commit",
  async (method) => {
    const response = await dispatch("selected", commitDocument, method, {
      requestId: "synthetic",
    });
    expectError(response, "tab 7 access was revoked");
  },
);
