import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cdp,
  connectRelay,
  createTab,
  expectType,
  expectResult,
  expectUnused,
  loadConfiguredBackground,
  runtime,
  waitCalled,
} from "./background.lifecycle-test-helpers.js";
import { cleanupBackgroundHarnesses } from "./background.test-harness.js";

const url = "https://example.com/destination";
const accessMode = "selected";
const navigation = { frameId: "main", loaderId: "destination" };
const navigationEvent = { frame: { id: "main", loaderId: "destination", url } };
async function setup(
  mode: "all" | "selected" = "all",
  tabs: Parameters<typeof loadConfiguredBackground>[1] = [
    { id: 100, url: "https://example.com/unrelated", groupId: 7 },
    { id: 99, url: "about:blank", groupId: 7 },
  ],
) {
  const harness = await loadConfiguredBackground(mode, tabs);
  const { frames, request } = await connectRelay(harness);
  const group = harness.tabsGroup.getMockImplementation()!;
  harness.tabsGroup.mockImplementation(async (properties) => {
    const groupId = await group(properties);
    for (const tabId of properties.tabIds) {
      harness.updateTab(tabId, { groupId });
    }
    harness.tabGroupUpdatedListener?.({ id: groupId, title: "" });
    return groupId;
  });
  harness.tabGroupsUpdate.mockImplementation(async () => {
    harness.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
  });
  const create = async () => {
    expectResult(await request({ ...createTab(), background: true }), { tabId: 101 });
  };
  return Object.assign(harness, { request, frames, create });
}
async function attached() {
  const h = await setup("selected");
  await h.create();
  expectType(await h.request({ type: "attach", tabId: 101 }));
  return h;
}
const revokedMessage = expect.stringMatching(
  /access was revoked|restricted or unavailable|Debugger attachment retired/,
);
function expectError(response: unknown, message: unknown) {
  expect(response).toMatchObject({ type: "error", message });
}
const releases: Array<() => void> = [];
beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

type Harness = Awaited<ReturnType<typeof setup>>;
async function dispatchConfiguration(
  mode: "all" | "selected",
  duringCommand: (h: Harness) => void | Promise<unknown>,
  method = "Network.setCacheDisabled",
  params: Record<string, unknown> = { cacheDisabled: true },
) {
  const h = await setup(mode, [
    { id: 7, url: "https://example.com/source", groupId: 7, windowId: 1 },
  ]);
  expectType(await h.request({ type: "attach", tabId: 7 }));
  const native = h.debuggerSendCommand.getMockImplementation()!;
  h.debuggerSendCommand.mockImplementation(async (source, command, args) => {
    if (command !== method) {
      return await native(source, command, args);
    }
    await duringCommand(h);
    return {};
  });
  return await h.request(cdp(method, params, 7));
}
function expectConfigurationError(response: Record<string, unknown>, message?: string) {
  expect(response).toMatchObject({ type: "error", ...(message ? { message } : {}) });
  expect(response.result).toBeUndefined();
}
function commitDocument(h: Harness) {
  h.updateTab(7, { url, pendingUrl: undefined });
  h.debuggerEventListener?.({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "root", loaderId: "destination", url },
  });
  h.debuggerEventListener?.({ tabId: 7 }, "Page.lifecycleEvent", {
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
      expectResult(await dispatchConfiguration(mode, commitDocument, method, params), {});
    },
  );
  it("rejects a cache-setting receipt after genuine access revocation", async () => {
    expectConfigurationError(
      await dispatchConfiguration(mode, (h) =>
        runtime(h, "toggleTabAccess", { tabId: 7, accessMode: mode, grant: false }),
      ),
    );
  });
});
it("rejects a cache-setting receipt after debugger detach", async () => {
  expectConfigurationError(
    await dispatchConfiguration("selected", (h) =>
      h.debuggerDetachListener?.({ tabId: 7 }, "canceled_by_user"),
    ),
  );
});
it.each(["Network.getResponseBody", "Fetch.getResponseBody"])(
  "rejects document-sensitive %s after an allowed document commit",
  async (method) => {
    expectConfigurationError(
      await dispatchConfiguration("selected", commitDocument, method, { requestId: "synthetic" }),
      "tab 7 access was revoked",
    );
  },
);

describe("physical tab creation authority", () => {
  it.each(["initial blank", "committed then blank", "removed"] as const)(
    "honors %s observed before tabs.create resolves",
    async (observation) => {
      const h = await setup();
      const create = h.tabsCreate.getMockImplementation()!;
      h.tabsCreate.mockImplementationOnce(async (properties) => {
        const tab = await create(properties);
        if (observation === "initial blank") {
          h.updateTab(tab.id, { url: "about:blank" });
        } else if (observation === "committed then blank") {
          h.updateTab(tab.id, { url: "https://example.com/committed" });
          h.updateTab(tab.id, { url: "about:blank" }, false);
        } else {
          h.tabsRemovedListener?.(tab.id);
        }
        return tab;
      });
      expectType(
        await h.request(createTab()),
        observation === "initial blank" ? "result" : "error",
      );
      expectUnused(h.tabsRemove);
    },
  );
  it("keeps an HTTP creation revoked after group removal and restoration before its callback", async () => {
    const h = await setup("selected");
    const create = h.tabsCreate.getMockImplementation()!;
    h.tabsCreate.mockImplementationOnce(async (properties) => {
      const tab = await create(properties);
      for (const groupId of [7, -1, 7]) {
        h.updateTab(tab.id, { groupId });
      }
      return tab;
    });
    expect(await h.request(createTab("https://example.com/destination"))).toMatchObject({
      type: "error",
      message: "created tab is no longer available",
    });
    expectUnused(h.debuggerAttach, h.tabsRemove);
  });
  it.each(["initial loading snapshot", "same-group update"] as const)(
    "preserves navigation with a late %s",
    async (event) => {
      const h = await attached();
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        h.updateTab(101, { pendingUrl: url }, false);
        const initialLoadingTab = await h.tabsGet(101);
        h.updateTab(101, { url, pendingUrl: undefined }, false);
        h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", navigationEvent);
        if (event === "initial loading snapshot") {
          h.tabsUpdatedListener?.(101, { status: "loading" }, initialLoadingTab);
        } else {
          const tab = { ...initialLoadingTab, url, pendingUrl: undefined };
          h.tabsUpdatedListener?.(101, { groupId: tab.groupId }, tab);
        }
        return { ...navigation };
      });
      expectResult(await h.request(cdp("Page.navigate", { url })), navigation);
      expectUnused(h.debuggerDetach);
    },
  );
  it("keeps loading-snapshot authority revoked after group removal and restoration", async () => {
    const h = await attached();
    const initialLoadingTab = { ...(await h.tabsGet(101)), pendingUrl: url };
    h.updateTab(101, { url }, false);
    h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", navigationEvent);
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      h.updateTab(101, { groupId: -1 });
      h.updateTab(101, { groupId: 7 });
      h.tabsUpdatedListener?.(101, { status: "loading" }, initialLoadingTab);
      return { ...navigation };
    });
    expectError(await h.request(cdp("Page.navigate", { url })), revokedMessage);
    expect(h.debuggerSendCommand).toHaveBeenCalledWith({ tabId: 101 }, "Page.navigate", { url });
  });
  it("restores fresh attachment authority without reviving a command admitted before a title change", async () => {
    const h = await setup("selected");
    h.tabGroupsUpdate.mockResolvedValueOnce(undefined);
    await h.create();
    expectType(await h.request({ type: "attach", tabId: 101 }));
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      h.tabGroupUpdatedListener?.({ id: 7, title: "Other" });
      h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
      return { frameId: "main" };
    });
    expectError(
      await h.request(cdp("Page.navigate", { url })),
      expect.stringContaining("access was revoked"),
    );
    await vi.waitFor(() => {
      h.debuggerEventListener?.({ tabId: 101 }, "Runtime.consoleAPICalled", { value: 1 });
      expect(h.frames()).toContainEqual(
        expect.objectContaining({ type: "cdpEvent", method: "Runtime.consoleAPICalled" }),
      );
    });
    expectType(await h.request(cdp("Runtime.enable")));
  });
  it.each(["removal", "lookup"])(
    "revokes creation when group %s beats its callback",
    async (event) => {
      const h = await setup("selected");
      h.tabGroupsUpdate.mockImplementationOnce(async () => {
        if (event === "removal") {
          h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
          h.tabGroupRemovedListener?.({ id: 7, title: "OpenClaw" });
        } else {
          h.tabGroupsGet.mockResolvedValue({ id: 7, title: "Other", windowId: 1 });
        }
      });
      expectType(await h.request(createTab()), "error");
      expectUnused(h.tabsRemove);
    },
  );
  it.each(["removed", "pause"] as const)(
    "rechecks %s after the failure-cleanup lookup yields",
    async (reason) => {
      const h = await setup();
      const lookup = createDeferred<Awaited<ReturnType<typeof h.tabsGet>>>();
      let inspectingCleanup = false;
      h.debuggerAttach.mockImplementationOnce(async () => {
        const tab = await h.tabsGet(101);
        releases.push(() => lookup.resolve(tab));
        h.tabsGet.mockImplementationOnce(async () => {
          inspectingCleanup = true;
          return await lookup.promise;
        });
        throw new Error("attach failed");
      });
      const attaching = h.request(createTab());
      await vi.waitFor(() => expect(inspectingCleanup).toBe(true));
      let pausing: Promise<unknown> | undefined;
      if (reason === "removed") {
        h.tabsRemovedListener?.(101);
      } else {
        pausing = runtime(h, "toggleTabAccess", { accessMode: "all", tabId: 101, grant: false });
        await vi.waitFor(() => expect(h.sessionStorageValues.deniedTabIdsV1).toEqual([101]));
      }
      lookup.resolve(await h.tabsGet(101));
      await pausing;
      expectError(await attaching, "attach failed");
      expectUnused(h.tabsRemove);
    },
  );
  it("fences a selected revoke while grouping and leaves the user tab alone", async () => {
    const h = await setup("selected");
    const deferred = createDeferred<number>();
    releases.push(() => deferred.resolve(7));
    const group = h.tabsGroup.getMockImplementation()!;
    h.tabsGroup.mockImplementationOnce(async (properties) => {
      await group(properties);
      return await deferred.promise;
    });
    const creating = h.request({ ...createTab(), focus: true });
    await waitCalled(h.tabsGroup);
    expect(
      await runtime(h, "toggleTabAccess", { accessMode, tabId: 101, grant: false }),
    ).toMatchObject({ ok: true });
    deferred.resolve(7);
    expectError(await creating, expect.stringMatching(/revoked/));
    expectUnused(h.windowsUpdate, h.tabsRemove);
    expectType(await h.request({ type: "attach", tabId: 101 }), "error");
  });
});
