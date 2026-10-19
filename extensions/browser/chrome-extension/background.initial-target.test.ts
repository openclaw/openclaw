import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import {
  cdp,
  connectCdpClient,
  connectExtension,
  createTab,
  deferredScope,
  expectType,
  expectUnused,
  relayConfig,
  runtime,
  waitCalled,
} from "./background.lifecycle-test-helpers.js";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  loadRelayCommandHarness as createHarness,
} from "./background.test-harness.js";
const { deferred, releaseAll } = deferredScope();
type Harness = Awaited<ReturnType<typeof createHarness>>;
const revoke = {
  cancel: (h: Harness) => h.debuggerDetachListener?.({ tabId: 101 }, "canceled_by_user"),
  group: (h: Harness) => h.updateTab(101, { groupId: -1 }),
  replacement: (h: Harness) => h.tabsReplacedListener(102, 101),
  removal: (h: Harness) => h.tabsRemovedListener?.(101),
  file: (h: Harness) => h.updateTab(101, { url: "file:///tmp/private.html" }),
};
function createdProperties(h: Harness, properties: Record<string, unknown>) {
  const create = h.tabsCreate.getMockImplementation()!;
  h.tabsCreate.mockImplementation(async (params) =>
    Object.assign(await create(params), properties),
  );
}
async function heldCreation(h: Harness, stage: "attach" | "group" = "attach") {
  const completion = deferred(undefined);
  const mock = stage === "attach" ? h.debuggerAttach : h.tabGroupsUpdate;
  mock.mockImplementationOnce(() => completion.promise);
  const result = h.command(createTab());
  await waitCalled(mock);
  return { result, finish: completion.resolve };
}
async function heldCommand(h: Harness, message: Record<string, unknown>) {
  const completion = deferred({});
  h.debuggerSendCommand.mockImplementationOnce(() => completion.promise);
  const result = h.command(message);
  await waitCalled(h.debuggerSendCommand);
  return { result, finish: completion.resolve };
}
beforeEach(() => vi.resetModules());
afterEach(async () => {
  vi.restoreAllMocks();
  releaseAll();
  await cleanupBackgroundHarnesses();
  vi.doUnmock("./modules/tab-access.js");
  vi.unstubAllGlobals();
});

describe("created initial target in selected mode", () => {
  const mode = "selected";
  it("does not reclaim redirected HTTP creation after attachment fails", async () => {
    const h = await createHarness(mode);
    createdProperties(h, { url: "", pendingUrl: "https://example.com/start" });
    const group = h.tabsGroup.getMockImplementation()!;
    h.tabsGroup.mockImplementationOnce(async (params) => {
      h.updateTab(101, { url: "https://example.com/redirected", pendingUrl: undefined });
      return await group(params);
    });
    h.debuggerAttach.mockRejectedValueOnce(new Error("attach failed"));
    expectType(await h.command(createTab("https://example.com/start")), "error");
    expect(h.debuggerAttach).toHaveBeenCalledExactlyOnceWith({ tabId: 101 }, "1.3");
    expectUnused(h.tabsRemove);
  });
  it("retires an unhanded blank when a lookup observes takeover before the URL event", async () => {
    const h = await createHarness(mode);
    const creating = await heldCreation(h);
    const get = h.tabsGet.getMockImplementation()!;
    h.tabsGet.mockImplementation(async (tabId) => ({
      ...(await get(tabId)),
      url: "https://example.com/user-takeover",
    }));
    await runtime(h, "getTabAccess", { tabId: 101 });
    h.updateTab(101, { url: "https://example.com/user-takeover" });
    creating.finish();
    expectType(await creating.result, "error");
    expectUnused(h.tabsRemove);
  });
  it.each(["Chrome query", "completed policy read"])(
    "keeps a blank-first CDP target alive when an earlier %s resolves after creation",
    async (phase) => {
      let inspecting = false;
      let holdSnapshot = false;
      const inventory = deferred(undefined);
      if (phase === "completed policy read") {
        vi.doMock("./modules/tab-access.js", async (importOriginal) => {
          const actual = await importOriginal<typeof import("./modules/tab-access.js")>();
          return {
            ...actual,
            createTabAccessPolicy: (...args: Parameters<typeof actual.createTabAccessPolicy>) => {
              const policy = actual.createTabAccessPolicy(...args);
              const list = policy.listAccessibleTabs.bind(policy);
              policy.listAccessibleTabs = async (...listArgs) => {
                const snapshot = await list(...listArgs);
                if (holdSnapshot) {
                  holdSnapshot = false;
                  inspecting = true;
                  await inventory.promise;
                }
                return snapshot;
              };
              return policy;
            },
          };
        });
      }
      const h = await createHarness(mode);
      h.tabGroupsQuery.mockResolvedValue([{ id: 7, windowId: 1 }]);
      const bridge = new ExtensionRelayBridge();
      connectExtension(bridge, h);
      const client = connectCdpClient(bridge);
      const request: typeof client.requestResult = (...args) => client.requestResult(...args);
      try {
        await request("Target.setAutoAttach", { autoAttach: true, flatten: true });
        const staleTabs = await h.tabsQuery();
        if (phase === "Chrome query") {
          h.tabsQuery.mockImplementationOnce(async () => {
            inspecting = true;
            await inventory.promise;
            return staleTabs;
          });
        } else {
          // Hold the real completed read at the await boundary before publication.
          holdSnapshot = true;
        }
        h.updateTab(100, { url: "about:blank" });
        await vi.waitFor(() => expect(inspecting).toBe(true));
        expect(await request("Target.createTarget", { url: "about:blank" })).toEqual({
          targetId: "tab-101",
        });
        const sessionId = client.root("tab-101");
        expect(sessionId).toBeTruthy();
        const inventoryCount = h.frames().filter((frame) => frame.type === "tabs").length;
        inventory.resolve();
        await vi.waitFor(() =>
          expect(h.frames().filter((frame) => frame.type === "tabs").length).toBeGreaterThan(
            inventoryCount,
          ),
        );
        await request("Page.enable", {}, sessionId);
        h.debuggerSendCommand.mockImplementationOnce(async () => {
          h.updateTab(101, { url: "https://example.com/" });
          return { frameId: "frame-101", loaderId: "next-document" };
        });
        await request("Page.navigate", { url: "https://example.com/" }, sessionId);
        await request("Runtime.evaluate", { expression: "document.title" }, sessionId);
        await request("Target.detachFromTarget", { sessionId });
        expect(await request("Target.closeTarget", { targetId: "tab-101" })).toEqual({
          success: true,
        });
        expect(h.debuggerAttach).toHaveBeenCalledExactlyOnceWith({ tabId: 101 }, "1.3");
        expect(h.tabsRemove).toHaveBeenCalledExactlyOnceWith(101);
      } finally {
        await client.close();
        bridge.dispose();
      }
    },
  );
  it.each([{ pendingUrl: "chrome://settings" }, { incognito: true }])(
    "does not grant initial ownership over a restricted created tab: %j",
    async (properties) => {
      const h = await createHarness(mode);
      createdProperties(h, properties);
      expectType(await h.command(createTab()), "error");
      expectUnused(h.debuggerAttach);
      expectType(await h.command({ type: "attach", tabId: 100 }), "error");
    },
  );
  it.each(["matching", "different"])(
    "checks a lagging initial-blank snapshot against the native commit with a %s pending URL",
    async (pending) => {
      const h = await createHarness(mode);
      await h.command(createTab());
      const url = "https://example.com/destination";
      const result = { frameId: "frame-101", loaderId: "destination" };
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        h.updateTab(
          101,
          { pendingUrl: pending === "matching" ? url : "https://example.com/other" },
          false,
        );
        const getGroup = h.tabGroupsGet.getMockImplementation()!;
        // Commit between the two access reads, before Chrome's tab snapshot catches up.
        h.tabGroupsGet.mockImplementationOnce(async (groupId) => {
          h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
            frame: { id: result.frameId, loaderId: result.loaderId, url },
          });
          return await getGroup(groupId);
        });
        return result;
      });
      const response = await h.command(cdp("Page.navigate", { url }));
      if (pending !== "matching") {
        expectType(response, "error");
        return;
      }
      expect(response, JSON.stringify(response)).toMatchObject({ type: "result", result });
      h.updateTab(100, { title: "Trigger discovery" });
      await vi.waitFor(() =>
        expect(h.frames().findLast((frame) => frame.type === "tabs")?.tabs).toContainEqual(
          expect.objectContaining({ tabId: 101, url }),
        ),
      );
      expectUnused(h.debuggerDetach);
      h.updateTab(101, { url, pendingUrl: undefined });
      expectType(await h.command(cdp("Runtime.evaluate")));
      h.updateTab(101, { url: "about:blank" });
      expectType(await h.command({ type: "attach", tabId: 101 }), "error");
      expectType(await h.command({ type: "closeTab", tabId: 101 }), "error");
      expectUnused(h.tabsRemove);
    },
  );
  it("fences commands and events immediately on a restricted pending destination", async () => {
    const h = await createHarness(mode);
    await h.command(createTab());
    const executing = await heldCommand(h, cdp("Runtime.evaluate"));
    h.updateTab(101, { pendingUrl: "chrome://settings" });
    h.debuggerEventListener?.({ tabId: 101 }, "Runtime.consoleAPICalled", {});
    expect(h.frames().some((frame) => frame.type === "cdpEvent")).toBe(false);
    executing.finish();
    expectType(await executing.result, "error");
    expectType(await h.command({ type: "attach", tabId: 101 }), "error");
  });
  it("finishes bootstrap when Chrome commits the original pending blank after handoff", async () => {
    const h = await createHarness(mode);
    createdProperties(h, { url: "", pendingUrl: "about:blank" });
    expectType(await h.command(createTab()));
    const initializing = await heldCommand(h, cdp("Page.enable"));
    h.updateTab(101, { url: "about:blank", pendingUrl: undefined });
    initializing.finish();
    expectType(await initializing.result);
    expectType(await h.command({ type: "closeTab", tabId: 101 }));
  });
  it.each([true, false])(
    "handles late self-group naming with prior revocation: %s",
    async (revoked) => {
      const h = await createHarness(mode);
      if (!revoked) {
        h.tabGroupsUpdate.mockResolvedValueOnce(undefined);
      }
      const creating = await heldCreation(h, revoked ? "group" : "attach");
      if (revoked) {
        await runtime(h, "toggleTabAccess", { tabId: 101, accessMode: mode, grant: false });
      }
      h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
      creating.finish();
      expectType(await creating.result, revoked ? "error" : "result");
      expectUnused(h.tabsRemove);
      if (revoked) {
        expectUnused(h.debuggerAttach);
      }
    },
  );
  it("keeps Pause/Allow or selected-group regrant coherent for the same initial document", async () => {
    const h = await createHarness(mode);
    await h.command(createTab());
    for (const grant of [false, true]) {
      expect(
        await runtime(h, "toggleTabAccess", { tabId: 101, accessMode: mode, grant }),
      ).toMatchObject({ ok: true, accessible: grant });
      expectType(await h.command({ type: "attach", tabId: 101 }), grant ? "result" : "error");
    }
  });
  it.each(["pause", "cancel", "group", "replacement", "removal"] as const)(
    "fences an in-flight creation after %s without rolling back a taken-over tab",
    async (revocation) => {
      const h = await createHarness(mode);
      const creating = await heldCreation(h);
      let mutation: Promise<unknown> | undefined;
      if (revocation === "pause") {
        mutation = runtime(h, "toggleTabAccess", {
          tabId: 101,
          accessMode: mode,
          grant: false,
        });
        await vi.waitFor(async () =>
          expect(await runtime(h, "getTabAccess", { tabId: 101 })).toMatchObject({
            accessible: false,
          }),
        );
      } else {
        revoke[revocation](h);
        if (revocation === "replacement" || revocation === "removal") {
          // A copied/reused snapshot must not restore authority after the event.
          h.updateTab(revocation === "replacement" ? 102 : 101, { url: "about:blank", groupId: 7 });
        }
      }
      creating.finish();
      expectType(await creating.result, "error");
      await mutation;
      expectUnused(h.tabsRemove);
      if (revocation === "cancel") {
        // Chrome's onDetach already destroyed this exact native client.
        expectUnused(h.debuggerDetach);
      } else {
        expect(h.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-101" });
      }
      if (revocation === "replacement") {
        expectType(await h.command({ type: "attach", tabId: 102 }), "error");
      }
    },
  );
  it("does not restore initial provenance from group snapshots after worker restart", async () => {
    const h = await createHarness(mode);
    await h.command(createTab());
    const initialTabs = await h.tabsQuery();
    await cleanupBackgroundHarnesses();
    vi.resetModules();
    const restarted = await loadBackground({
      storedConfig: { ...h.storageValues, ...relayConfig(mode) },
      initialTabs,
    });
    expect(await runtime(restarted, "getTabAccess", { tabId: 101 })).toMatchObject({
      accessible: false,
      eligible: false,
    });
  });
  it("preserves the original failure and reports failed rollback", async () => {
    const h = await createHarness(mode);
    h.tabsGroup.mockRejectedValueOnce(new Error("group failed"));
    h.tabsRemove.mockRejectedValueOnce(new Error("remove failed"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await h.command(createTab())).toMatchObject({
      type: "error",
      message: "group failed; cleanup failed for created tab 101; close it manually.",
    });
    expect(warning).toHaveBeenCalledWith("Cleanup failed for created tab 101; close it manually.");
  });
});

describe("navigation command authority", () => {
  it("retires stale page data across a reload without a URL change", async () => {
    const h = await createHarness("selected");
    await h.command(createTab("https://example.com/same"));
    const reading = await heldCommand(h, cdp("Runtime.evaluate"));
    h.updateTab(101, { status: "loading" });
    reading.finish();
    expectType(await reading.result, "error");
  });
  it.each([
    { mode: "all" as const, revocation: "group" },
    { mode: "selected" as const, revocation: "cancel" },
    { mode: "selected" as const, revocation: "replacement" },
    { mode: "selected" as const, revocation: "file" },
  ] as const)(
    "rejects navigation completion after $revocation in $mode even if an ordinary document returns",
    async ({ mode, revocation }) => {
      const h = await createHarness(mode);
      await h.command(createTab());
      const navigating = await heldCommand(
        h,
        cdp("Page.navigate", { url: "https://example.com/next" }),
      );
      h.updateTab(101, { url: "https://example.com/next" });
      if (revocation === "group") {
        await runtime(h, "setAccessMode", { accessMode: "selected" });
      }
      revoke[revocation](h);
      h.updateTab(101, {
        url: "https://example.com/returned",
        pendingUrl: undefined,
        incognito: false,
      });
      navigating.finish();
      expectType(await navigating.result, "error");
      expectUnused(h.tabsRemove);
    },
  );
});
