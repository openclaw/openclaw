import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cdp,
  connectRelay,
  expectType,
  expectUnused,
  loadConfiguredBackground,
  runtime,
} from "./background.lifecycle-test-helpers.js";
import { cleanupBackgroundHarnesses } from "./background.test-harness.js";
const originalUrl = "https://example.com/existing";
const blankResult = { frameId: "root", loaderId: "blank-loader" };
const frame = (url = "about:blank", loaderId = "blank-loader") => ({
  frame: { id: "root", loaderId, url },
});

async function setup(complete = () => blankResult) {
  const h = await loadConfiguredBackground("selected", [
    { id: 7, url: originalUrl, groupId: 7, windowId: 1 },
    { id: 8, url: "about:blank", groupId: 7 },
  ]);
  const connection = await connectRelay(h);
  const { request } = connection;
  expectType(await request({ type: "attach", tabId: 7 }));
  const emit = (method: string, params: unknown) =>
    h.debuggerEventListener?.({ tabId: 7 }, method, params);
  h.debuggerSendCommand.mockImplementation(async (_source, method) => {
    if (method === "Page.getFrameTree") {
      return { frameTree: frame(originalUrl, "original") };
    }
    if (method !== "Page.navigate") {
      return {};
    }
    h.updateTab(7, { url: "about:blank" });
    emit("Runtime.executionContextsCleared", {});
    emit("Page.frameNavigated", frame());
    emit("Page.lifecycleEvent", { ...blankResult, name: "load" });
    return complete();
  });
  const command = (method: string, params?: Record<string, unknown>, extra = {}) =>
    request({ ...cdp(method, params, 7), ...extra });
  const navigate = (params: Record<string, unknown> = { url: "about:blank", frameId: "root" }) =>
    command("Page.navigate", params);
  const staleLookup = (update: (tabId: number) => void) => {
    const get = h.tabsGet.getMockImplementation()!;
    h.tabsGet.mockImplementationOnce(async (id) => {
      const stale = await get(id);
      update(id);
      return stale;
    });
  };
  return Object.assign(h, connection, { command, emit, staleLookup, navigate });
}
beforeEach(() => vi.resetModules());
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

describe("commanded existing document navigation", () => {
  it("preserves the native blank/reset/trace/return order in selected mode", async () => {
    const h = await setup();
    h.socket.send.mockClear();
    expect(await h.navigate()).toMatchObject({ type: "result", result: blankResult });
    expect(
      h
        .frames()
        .filter((f) => f.type === "cdpEvent" || f.seq)
        .map((f) => f.method ?? f.type),
    ).toEqual([
      "Runtime.executionContextsCleared",
      "Page.frameNavigated",
      "Page.lifecycleEvent",
      "result",
    ]);
    expectType(await h.command("Tracing.start"));
    expectType(await h.request({ type: "attach", tabId: 8 }), "error");
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      h.staleLookup((id) => {
        h.updateTab(id, { url: originalUrl }, false);
        h.emit("Page.frameNavigated", frame(originalUrl, "return"));
      });
      return { frameId: "root", loaderId: "return" };
    });
    expectType(await h.navigate({ url: originalUrl }));
    expectType(await h.command("Tracing.end"));
    h.updateTab(7, { url: "about:blank" });
    expect(await runtime(h, "getTabAccess", { tabId: 7 })).toMatchObject({ accessible: false });
    expectUnused(h.tabsRemove, h.tabsUpdate);
  });
  it.each([
    ["https://example.com/next", "result"],
    ["chrome://settings", "error"],
  ])("revalidates pending %s between response lookups", async (pendingUrl, response) => {
    const h = await setup(() => {
      h.staleLookup((id) => h.updateTab(id, { pendingUrl }));
      return blankResult;
    });
    expectType(await h.navigate(), response);
    expectUnused(h.tabsRemove);
    if (response === "result") {
      expectType(await h.request({ type: "closeTab", tabId: 7 }));
      expect(h.tabsRemove).toHaveBeenCalledExactlyOnceWith(7);
    }
  });
  it("rejects forged authorization and unowned blank navigation", async () => {
    const h = await setup();
    h.updateTab(7, { url: "about:blank" });
    expectType(await h.command("Tracing.start", undefined, { authorized: true }), "error");
    expectType(await h.request(cdp("Page.navigate", { url: "about:blank" }, 8)), "error");
    expectUnused(h.tabsRemove);
  });
});
