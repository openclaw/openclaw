import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cdp,
  connectRelay,
  deferredScope,
  expectType,
  expectUnused,
  loadConfiguredBackground,
  relayReply,
  runtime,
} from "./background.lifecycle-test-helpers.js";
import { cleanupBackgroundHarnesses } from "./background.test-harness.js";
const originalUrl = "https://example.com/existing";
const blankResult = { frameId: "root", loaderId: "blank-loader" };
const frame = (url = "about:blank", loaderId = "blank-loader") => ({
  frame: { id: "root", loaderId, url },
});

async function setup() {
  const h = await loadConfiguredBackground("selected", [
    { id: 7, url: originalUrl, groupId: 7, windowId: 1 },
    { id: 8, url: "about:blank", groupId: 7 },
  ]);
  const connection = await connectRelay(h);
  const { request } = connection;
  expectType(await request({ type: "attach", tabId: 7 }));
  const emit = (method: string, params: unknown) =>
    h.debuggerEventListener?.({ tabId: 7 }, method, params);
  const native = (navigate: () => Promise<Record<string, unknown>>) => {
    h.debuggerSendCommand.mockImplementation(async (_source, method) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: frame(originalUrl, "original") };
      }
      return method === "Page.navigate" ? await navigate() : {};
    });
  };
  const command = (method: string, params?: Record<string, unknown>, extra = {}) =>
    request({ ...cdp(method, params, 7), ...extra });
  const navigate = (params: Record<string, unknown> = { url: "about:blank", frameId: "root" }) =>
    command("Page.navigate", params);
  const commit = (
    complete: () => Record<string, unknown> | Promise<Record<string, unknown>> = () => blankResult,
  ) =>
    native(async () => {
      h.updateTab(7, { url: "about:blank" });
      emit("Runtime.executionContextsCleared", {});
      emit("Page.frameNavigated", frame());
      emit("Page.lifecycleEvent", { ...blankResult, name: "load" });
      return await complete();
    });
  const staleLookup = (update: (tabId: number) => void) => {
    const get = h.tabsGet.getMockImplementation()!;
    h.tabsGet.mockImplementationOnce(async (id) => {
      const stale = await get(id);
      update(id);
      return stale;
    });
  };
  commit();
  return Object.assign(h, connection, { command, emit, commit, staleLookup, native, navigate });
}
const { deferred, releaseAll } = deferredScope();
beforeEach(() => vi.resetModules());
afterEach(async () => {
  releaseAll();
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
    { pendingUrl: "https://example.com/next", response: "result" },
    { pendingUrl: "chrome://settings", response: "error" },
  ])(
    "revalidates Selected pending $pendingUrl between response lookups",
    async ({ pendingUrl, response }) => {
      const h = await setup();
      h.commit(() => {
        h.staleLookup((id) => h.updateTab(id, { pendingUrl }));
        return blankResult;
      });
      expectType(await h.navigate(), response);
      expectUnused(h.tabsRemove);
      if (response === "result") {
        expectType(await h.request({ type: "closeTab", tabId: 7 }));
        expect(h.tabsRemove).toHaveBeenCalledExactlyOnceWith(7);
      }
    },
  );
  it("never mints selected access from an unowned or child blank", async () => {
    const h = await setup();
    h.native(async () => blankResult);
    expectType(await h.navigate({ url: "about:blank", frameId: "child" }));
    expectType(
      await h.command("Page.navigate", { url: "about:blank" }, { sessionId: "child-session" }),
    );
    h.updateTab(7, { url: "about:blank" });
    expectType(await h.command("Tracing.start", undefined, { authorized: true }), "error");
    expectType(await h.request(cdp("Page.navigate", { url: "about:blank" }, 8)), "error");
    expectUnused(h.tabsRemove);
  });
  it("fences a selected reconnect before response without deleting or restoring the tab", async () => {
    const h = await setup();
    const result = deferred(blankResult);
    h.commit(() => result.promise);
    const navigating = h.navigate();
    await vi.waitFor(() => expect(h.debuggerSendCommand.mock.calls.length).toBe(2));
    h.socket.send.mockClear();
    h.socket.close();
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(2));
    const replacement = h.relaySockets[1];
    assert(replacement);
    await h.authenticate(replacement);
    expectType(await relayReply(replacement, { type: "attach", tabId: 7, seq: 9001 }), "error");
    h.emit("Tracing.tracingComplete", { stream: "revoked-stream" });
    result.resolve(blankResult);
    // Closed sockets intentionally cannot receive the old response.
    await expect(navigating).rejects.toThrow();
    expect(h.frames().some((f) => f.type === "cdpEvent")).toBe(false);
    expect(await runtime(h, "getTabAccess", { tabId: 7 })).toMatchObject({ accessible: false });
    expectUnused(h.tabsRemove, h.tabsUpdate);
  });
  it("discards a stale selected discovery snapshot of the source before consuming blank provenance", async () => {
    const h = await setup();
    const staleTabs = await h.tabsQuery();
    const lookup = deferred(staleTabs);
    let inspecting = false;
    h.tabsQuery.mockImplementationOnce(async () => {
      inspecting = true;
      return await lookup.promise;
    });
    const status = runtime(h, "getStatus");
    await vi.waitFor(() => expect(inspecting).toBe(true));
    expectType(await h.navigate());
    lookup.resolve(staleTabs);
    await status;
    expectType(await h.command("Tracing.start"));
    expectUnused(h.tabsRemove);
  });
});
