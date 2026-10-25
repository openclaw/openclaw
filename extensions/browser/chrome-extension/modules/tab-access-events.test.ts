import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeEvent, storageArea } from "./browser.test-support.js";
import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";
import { registerTabAccessEvents } from "./tab-access-events.js";
import { createTabAccessPolicy, type TabAccessEpoch, type TabAccessMode } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

afterEach(() => vi.unstubAllGlobals());

const navigationEvents = [
  { method: "Network.responseReceived", params: { requestId: "navigation-1" } },
  { method: "Runtime.executionContextCreated", params: { context: { id: 12 } } },
  { method: "Page.frameNavigated", params: { frame: { id: "frame-7", loaderId: "loader-1" } } },
  { method: "Page.lifecycleEvent", params: { frameId: "frame-7", name: "load" } },
];

async function createNavigationHarness(
  mode: TabAccessMode,
  { fileAccessAllowed = true, groupId = mode === "selected" ? 11 : -1 } = {},
  accessReady: Promise<unknown> = Promise.resolve(),
) {
  let tab: BrowserTabSnapshot = {
    id: 7,
    url: "https://source.example/",
    groupId,
    incognito: false,
  };
  const chromeApi = {
    extension: { isAllowedFileSchemeAccess: async () => fileAccessAllowed },
    storage: { session: storageArea() },
    tabs: {
      get: vi.fn(async (_tabId: number) => tab),
      query: vi.fn(async () => [tab]),
      onUpdated: chromeEvent<[number, { groupId?: number; url?: string }, BrowserTabSnapshot]>(),
      onRemoved: chromeEvent<[number]>(),
      onReplaced: chromeEvent<[number, number]>(),
    },
    tabGroups: {
      get: vi.fn(async (requestedGroupId: number) => ({
        id: requestedGroupId,
        title: requestedGroupId === 11 ? OPENCLAW_TAB_GROUP_TITLE : "Other",
      })),
      onUpdated: chromeEvent<[group?: { id: number; title?: string }]>(),
      onRemoved: chromeEvent<[group?: { id: number; title?: string }]>(),
    },
    debugger: {
      onEvent: chromeEvent<[{ tabId?: number; sessionId?: string }, string, unknown]>(),
      onDetach: chromeEvent<[{ tabId?: number }, string]>(),
    },
  };
  vi.stubGlobal("chrome", chromeApi);
  const policy = createTabAccessPolicy({});
  await policy.initialize(mode, true);
  const attachmentEpoch = policy.capture(7);
  await policy.requireTab(7, attachmentEpoch);
  const attachments = new Map<number, { epoch: TabAccessEpoch }>([[7, { epoch: attachmentEpoch }]]);
  const send = vi.fn<(message: Record<string, unknown>) => void>();
  const detachDebugger = vi.fn(async (tabId: number) => {
    attachments.delete(tabId);
  });
  registerTabAccessEvents({
    accessReady,
    policy,
    attachments,
    nativeDetached: (tabId: number) => attachments.delete(tabId),
    send,
    scheduleTabsSync() {},
    detachDebugger,
    pauseTab: async (tabId) => await policy.pause(tabId),
    removeTabFromOpenClawGroup: async () => {},
    runAccessMutation: async (task) => await task(),
  });
  return {
    chromeApi,
    policy,
    attachmentEpoch,
    attachments,
    send,
    detachDebugger,
    async controlBlank() {
      const epoch = policy.capture(7, "Page.navigate");
      await policy.requireTab(7, epoch);
      await policy.navigateTab(
        7,
        epoch,
        { url: "about:blank" },
        () => attachments.get(7)?.epoch,
        () => true,
        async (method) => {
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { id: "root", url: tab.url } } };
          }
          tab = { ...tab, url: "about:blank" };
          chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
            frame: { id: "root", loaderId: "blank", url: tab.url },
          });
          return { frameId: "root", loaderId: "blank" };
        },
      );
      await expect(policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
    },
    update(update: Partial<BrowserTabSnapshot>) {
      tab = { ...tab, ...update };
      chromeApi.tabs.onUpdated.emit(7, { url: tab.url }, tab);
    },
    emitNavigation() {
      for (const { method, params } of navigationEvents) {
        chromeApi.debugger.onEvent.emit({ tabId: 7 }, method, params);
      }
    },
    frameNavigated(url: string, loaderId = "return") {
      tab = { ...tab, url };
      chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
        frame: { id: "root", loaderId, url },
      });
    },
    deferLookup() {
      const { promise: pending, resolve: release } = Promise.withResolvers<BrowserTabSnapshot>();
      chromeApi.tabs.get.mockImplementation(async () => await pending);
      return async () => {
        release(tab);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      };
    },
  };
}

describe("Chrome navigation event access", () => {
  it("waits for the stored mode before completing user cancellation", async () => {
    const ready = Promise.withResolvers<void>();
    const h = await createNavigationHarness("selected", {}, ready.promise);
    h.chromeApi.debugger.onDetach.emit({ tabId: 7 }, "canceled_by_user");
    expect(h.attachments.has(7)).toBe(false);
    expect(h.policy.isDenied(7)).toBe(false);
    await expect(h.policy.requireTab(7)).rejects.toThrow("access was revoked");
    h.policy.setMode("all");
    ready.resolve();
    await vi.waitFor(() => expect(h.policy.requireTab(7)).rejects.toThrow("paused for OpenClaw"));
  });

  it.each(["https://two.example/", "chrome://settings"])(
    "keeps the newer URL decision after an older lookup resumes: %s",
    async (url) => {
      const h = await createNavigationHarness("all");
      const stale = await h.chromeApi.tabs.get(7);
      const first = Promise.withResolvers<BrowserTabSnapshot>();
      const entered = Promise.withResolvers<void>();
      const inspect = vi.spyOn(h.policy, "inspectTab");
      h.chromeApi.tabs.get.mockImplementationOnce(() => {
        entered.resolve();
        return first.promise;
      });
      h.update({ url: "https://one.example/" });
      await entered.promise;
      h.update({ url });
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
      await inspect.mock.results[1].value;
      first.resolve(stale);
      await inspect.mock.results[0].value;
      h.send.mockClear();
      h.emitNavigation();
      if (url.startsWith("https:")) {
        expect(h.detachDebugger).not.toHaveBeenCalled();
        expect(h.send).toHaveBeenCalledTimes(navigationEvents.length);
      } else {
        expect(h.detachDebugger).toHaveBeenCalledExactlyOnceWith(7);
        expect(h.send).not.toHaveBeenCalled();
      }
    },
  );

  it("moves a paused replacement's denial and cleans both attachment identities", async () => {
    const h = await createNavigationHarness("all");
    await h.policy.pause(7);
    h.attachments.set(8, { epoch: h.policy.capture(8) });
    h.chromeApi.tabs.onReplaced.emit(8, 7);
    await vi.waitFor(() => expect(h.chromeApi.storage.session.values.deniedTabIdsV1).toEqual([8]));
    expect(h.policy.isDenied(8)).toBe(true);
    expect(h.policy.isDenied(7)).toBe(false);
    expect([...h.attachments.keys()]).toEqual([]);
  });

  it("does not refresh epochs from a stale group-wide access snapshot", async () => {
    const h = await createNavigationHarness("selected");
    const stale = await h.policy.listAccessibleTabs();
    const first = Promise.withResolvers<typeof stale>();
    const entered = Promise.withResolvers<void>();
    const list = vi.spyOn(h.policy, "listAccessibleTabs").mockImplementationOnce(() => {
      entered.resolve();
      return first.promise;
    });
    h.chromeApi.tabGroups.onUpdated.emit();
    await entered.promise;
    h.chromeApi.tabGroups.onUpdated.emit();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await list.mock.results[1].value;
    h.policy.invalidateTab(7);
    first.resolve(stale);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    h.send.mockClear();
    h.emitNavigation();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("projects native child session ids only while the attachment epoch is current", async () => {
    const h = await createNavigationHarness("selected");
    const params = { frame: { id: "child", loaderId: "child-loader", url: "about:blank" } };
    const emit = () => {
      for (const source of [{ tabId: 7 }, { tabId: 7, sessionId: "child-session" }]) {
        h.chromeApi.debugger.onEvent.emit(source, "Page.frameNavigated", params);
      }
    };
    emit();
    expect(h.send.mock.calls.map(([event]) => event.sessionId)).toEqual([
      undefined,
      "child-session",
    ]);
    h.send.mockClear();
    h.policy.invalidateTab(7);
    emit();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["pause", "mode change", "remove", "detach", "group rename", "group removal"])(
    "retires controlled blank authority on %s without reauthorizing it",
    async (reason) => {
      const h = await createNavigationHarness("all", { groupId: 11 });
      await h.controlBlank();
      switch (reason) {
        case "pause":
          await h.policy.pause(7);
          expect(h.policy.isDenied(7)).toBe(true);
          await h.policy.allow(7);
          break;
        case "mode change":
          h.policy.setMode("selected");
          h.policy.setMode("all");
          break;
        case "remove":
          h.chromeApi.tabs.onRemoved.emit(7);
          break;
        case "detach":
          h.chromeApi.debugger.onDetach.emit({ tabId: 7 }, "target_closed");
          break;
        case "group rename":
          h.chromeApi.tabGroups.onUpdated.emit({ id: 12, title: "Other" });
          await expect(h.policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
          h.chromeApi.tabGroups.onUpdated.emit({ id: 11, title: "Other" });
          break;
        case "group removal":
          h.chromeApi.tabGroups.onRemoved.emit({ id: 12 });
          await expect(h.policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
          h.chromeApi.tabGroups.onRemoved.emit({ id: 11 });
          break;
      }
      h.send.mockClear();
      h.emitNavigation();
      await expect(h.policy.requireTab(7)).rejects.toThrow(
        reason === "remove" ? "access was revoked" : "restricted or unavailable",
      );
      await expect(h.policy.requireTab(7)).rejects.toThrow("restricted or unavailable");
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it("discards a stale selected discovery snapshot of blank before return", async () => {
    const h = await createNavigationHarness("selected");
    await h.controlBlank();
    const stale = await h.chromeApi.tabs.query();
    const { promise: lookup, resolve: release } = Promise.withResolvers<BrowserTabSnapshot[]>();
    const { promise: started, resolve: queried } = Promise.withResolvers<void>();
    h.chromeApi.tabs.query.mockImplementationOnce(() => {
      queried();
      return lookup;
    });
    const discovering = h.policy.listAccessibleTabs();
    await started;
    try {
      h.frameNavigated("https://return.example/");
    } finally {
      release(stale);
    }
    const url = "https://return.example/";
    await expect(discovering).resolves.toEqual([expect.objectContaining({ id: 7, url })]);
    await expect(h.policy.requireTab(7)).resolves.toMatchObject({ id: 7, url });
  });

  it("preserves ordered navigation events in selected mode", async () => {
    const url = "https://destination.example/";
    const h = await createNavigationHarness("selected");
    const releaseLookup = h.deferLookup();
    try {
      h.update({ url });
      h.emitNavigation();

      expect(h.send.mock.calls.map(([frame]) => frame)).toEqual(
        navigationEvents.map((event) => ({ type: "cdpEvent", tabId: 7, ...event })),
      );
      await expect(h.policy.requireTab(7, h.attachmentEpoch)).rejects.toThrow("access was revoked");

      h.send.mockClear();
      h.update({ url: `${url}next` });
      h.emitNavigation();
      expect(h.send.mock.calls.map(([frame]) => frame.method)).toEqual(
        navigationEvents.map((event) => event.method),
      );
    } finally {
      await releaseLookup();
    }
    expect(h.detachDebugger).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<BrowserTabSnapshot>]>([
    ["restricted committed URL", { url: "chrome://settings" }],
    ["restricted pending URL", { pendingUrl: "chrome://settings" }],
    ["incognito tab", { incognito: true }],
    ["different selected group", { groupId: 12 }],
    ["wrong tab identity", { id: 8 }],
    ["paused tab", {}],
    ["changed group authority", {}],
    ["forged epoch copy", {}],
    ["replaced tab", {}],
  ])("does not renew access for %s from a URL snapshot", async (scenario, change) => {
    const h = await createNavigationHarness(scenario === "paused tab" ? "all" : "selected");
    const update = { url: "https://destination.example/", ...change };
    if (scenario === "paused tab") {
      await h.policy.pause(7);
    }
    const releaseLookup = h.deferLookup();
    try {
      switch (scenario) {
        case "changed group authority":
          h.chromeApi.tabGroups.onUpdated.emit();
          break;
        case "forged epoch copy":
          h.attachments.set(7, { epoch: { ...h.attachmentEpoch } });
          break;
        case "replaced tab":
          h.chromeApi.tabs.onReplaced.emit(8, 7);
          break;
      }
      h.send.mockClear();
      h.update(update);
      h.emitNavigation();
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      await releaseLookup();
    }
    // Events observed without authority must never replay after an async lookup.
    expect(h.send).not.toHaveBeenCalled();
  });

  it("preserves commands admitted after a newer tab event when an older group lookup completes", async () => {
    const h = await createNavigationHarness("selected");
    const { promise: pending, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: observed } = Promise.withResolvers<void>();
    const get = h.chromeApi.tabs.get.getMockImplementation()!;
    h.chromeApi.tabs.get.mockImplementationOnce(async (tabId) => {
      observed();
      await pending;
      return await get(tabId);
    });

    h.chromeApi.tabGroups.onRemoved.emit({ id: 12 });
    await started;
    try {
      h.update({ url: "https://destination.example/" });
      await vi.waitFor(() => {
        h.send.mockClear();
        h.emitNavigation();
        expect(h.send).toHaveBeenCalledTimes(navigationEvents.length);
      });
      const commandEpoch = h.policy.capture(7, "Page.navigate");
      await expect(h.policy.requireTab(7, commandEpoch)).resolves.toMatchObject({ id: 7 });
      release();
      // Drain the superseded lookup without introducing a second Chrome event.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await expect(h.policy.requireTab(7, commandEpoch)).resolves.toMatchObject({
        id: 7,
        url: "https://destination.example/",
      });
      expect(h.detachDebugger).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("does not retain file permission across a recreated extension policy", async () => {
    for (const fileAccessAllowed of [true, false]) {
      const h = await createNavigationHarness("all", { fileAccessAllowed });
      const releaseLookup = h.deferLookup();
      try {
        h.update({ url: "file:///tmp/openclaw-navigation-proof.html" });
        h.emitNavigation();
        expect(h.send).toHaveBeenCalledTimes(fileAccessAllowed ? navigationEvents.length : 0);
      } finally {
        await releaseLookup();
      }
      if (!fileAccessAllowed) {
        await expect(h.policy.requireTab(7)).rejects.toThrow("restricted or unavailable");
      }
    }
  });
});
