import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  loadRelayCommandHarness as createHarness,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
  REPLACEMENT_TEST_RELAY_KEY,
} from "./background.test-harness.js";

const pendingReleases = new Set<() => void>();
function deferred<T>(fallback: T) {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  const pending = { promise, resolve };
  const release = () => pending.resolve(fallback);
  pendingReleases.add(release);
  return {
    promise: pending.promise,
    resolve: (value = fallback) => {
      pendingReleases.delete(release);
      pending.resolve(value);
    },
  };
}

beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const release of pendingReleases) {
    release();
  }
  pendingReleases.clear();
  await cleanupBackgroundHarnesses();
  vi.doUnmock("./modules/tab-access.js");
  vi.unstubAllGlobals();
});

describe("created initial target in selected mode", () => {
  const mode = "selected";
  it.each([true])(
    "accepts initial HTTP redirects (attach failure: %s) without reclaiming a changed destination",
    async (failAttach) => {
      const harness = await createHarness(mode);
      const create = harness.tabsCreate.getMockImplementation()!;
      harness.tabsCreate.mockImplementation(async (params) =>
        Object.assign(await create(params), { url: "", pendingUrl: params.url }),
      );
      const group = harness.tabsGroup.getMockImplementation()!;
      harness.tabsGroup.mockImplementationOnce(async (params) => {
        harness.updateTab(101, { url: "https://example.com/redirected", pendingUrl: undefined });
        return await group(params);
      });
      if (failAttach) {
        harness.debuggerAttach.mockRejectedValueOnce(new Error("attach failed"));
      }
      expect(
        await harness.command({ type: "createTab", url: "https://example.com/start" }),
      ).toMatchObject({ type: failAttach ? "error" : "result" });
      expect(harness.debuggerAttach).toHaveBeenCalledExactlyOnceWith({ tabId: 101 }, "1.3");
      expect(harness.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it("retires an unhanded blank when a lookup observes takeover before the URL event", async () => {
    const harness = await createHarness(mode);
    const attaching = deferred(undefined);
    harness.debuggerAttach.mockImplementationOnce(async () => await attaching.promise);
    const creating = harness.command({ type: "createTab", url: "about:blank" });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());
    const get = harness.tabsGet.getMockImplementation()!;
    harness.tabsGet.mockImplementation(async (tabId) => ({
      ...(await get(tabId)),
      url: "https://example.com/user-takeover",
    }));
    await sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 101 });
    harness.updateTab(101, { url: "https://example.com/user-takeover" });
    attaching.resolve();
    expect(await creating).toMatchObject({ type: "error" });
    expect(harness.tabsRemove).not.toHaveBeenCalled();
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
      const harness = await createHarness(mode);
      harness.tabGroupsQuery.mockResolvedValue([{ id: 7, windowId: 1 }]);
      const bridge = new ExtensionRelayBridge();
      const extension = bridge.attachExtensionSocket({
        send: (raw) => harness.socket.receive(JSON.parse(raw)),
        close: () => harness.socket.close(),
      });
      const hello = harness.frames().find((frame) => frame.type === "hello");
      harness.socket.send.mockImplementation((raw: string) => extension.onMessage(raw));
      extension.onMessage(JSON.stringify(hello));
      const frames: Array<Record<string, unknown>> = [];
      const client = bridge.attachCdpClientSocket({
        send: (raw) => frames.push(JSON.parse(raw)),
        close() {},
      });
      let id = 0;
      const request = async (method: string, params = {}, sessionId?: string) => {
        const requestId = ++id;
        client.onMessage(JSON.stringify({ id: requestId, method, params, sessionId }));
        return await vi.waitFor(() => {
          const response = frames.find((frame) => frame.id === requestId);
          expect(response).toBeDefined();
          expect(response).not.toHaveProperty("error");
          return response?.result;
        });
      };
      try {
        await request("Target.setAutoAttach", { autoAttach: true, flatten: true });
        const staleTabs = await harness.tabsQuery();
        if (phase === "Chrome query") {
          harness.tabsQuery.mockImplementationOnce(async () => {
            inspecting = true;
            await inventory.promise;
            return staleTabs;
          });
        } else {
          // Hold the real completed read at the await boundary before publication.
          holdSnapshot = true;
        }
        harness.updateTab(100, { url: "about:blank" });
        await vi.waitFor(() => expect(inspecting).toBe(true));
        expect(await request("Target.createTarget", { url: "about:blank" })).toEqual({
          targetId: "tab-101",
        });
        const attached = frames.find((frame) => frame.method === "Target.attachedToTarget")
          ?.params as { sessionId: string };
        expect(attached.sessionId).toBeTruthy();
        const inventoryCount = harness.frames().filter((frame) => frame.type === "tabs").length;
        inventory.resolve();
        await vi.waitFor(() =>
          expect(harness.frames().filter((frame) => frame.type === "tabs").length).toBeGreaterThan(
            inventoryCount,
          ),
        );
        await request("Page.enable", {}, attached.sessionId);
        harness.debuggerSendCommand.mockImplementationOnce(async () => {
          harness.updateTab(101, { url: "https://example.com/" });
          return { frameId: "frame-101", loaderId: "next-document" };
        });
        await request("Page.navigate", { url: "https://example.com/" }, attached.sessionId);
        await request("Runtime.evaluate", { expression: "document.title" }, attached.sessionId);
        await request("Target.detachFromTarget", { sessionId: attached.sessionId });
        expect(await request("Target.closeTarget", { targetId: "tab-101" })).toEqual({
          success: true,
        });
        expect(harness.debuggerAttach).toHaveBeenCalledExactlyOnceWith({ tabId: 101 }, "1.3");
        expect(harness.tabsRemove).toHaveBeenCalledExactlyOnceWith(101);
      } finally {
        await client.onClose();
        bridge.dispose();
      }
    },
  );

  it.each([{ pendingUrl: "chrome://settings" }, { incognito: true }])(
    "does not grant initial ownership over a restricted created tab: %j",
    async (properties) => {
      const harness = await createHarness(mode);
      const create = harness.tabsCreate.getMockImplementation()!;
      harness.tabsCreate.mockImplementation(async (params) =>
        Object.assign(await create(params), properties),
      );
      expect(await harness.command({ type: "createTab", url: "about:blank" })).toMatchObject({
        type: "error",
      });
      expect(harness.debuggerAttach).not.toHaveBeenCalled();
      expect(await harness.command({ type: "attach", tabId: 100 })).toMatchObject({
        type: "error",
      });
    },
  );

  it.each(["matching", "different"])(
    "checks a lagging initial-blank snapshot against the native commit with a %s pending URL",
    async (pending) => {
      const harness = await createHarness(mode);
      await harness.command({ type: "createTab", url: "about:blank" });
      const url = "https://example.com/destination";
      const result = { frameId: "frame-101", loaderId: "destination" };
      harness.debuggerSendCommand.mockImplementationOnce(async () => {
        harness.updateTab(
          101,
          {
            pendingUrl: pending === "matching" ? url : "https://example.com/other",
          },
          false,
        );
        const commit = () =>
          harness.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
            frame: { id: result.frameId, loaderId: result.loaderId, url },
          });
        const getGroup = harness.tabGroupsGet.getMockImplementation()!;
        // Commit between the two access reads, before Chrome's tab snapshot catches up.
        harness.tabGroupsGet.mockImplementationOnce(async (groupId) => {
          commit();
          return await getGroup(groupId);
        });
        return result;
      });
      const response = await harness.command({
        type: "cdp",
        tabId: 101,
        method: "Page.navigate",
        params: { url },
      });
      if (pending !== "matching") {
        expect(response).toMatchObject({ type: "error" });
        return;
      }
      expect(response, JSON.stringify(response)).toMatchObject({ type: "result", result });
      harness.updateTab(100, { title: "Trigger discovery" });
      await vi.waitFor(() =>
        expect(harness.frames().findLast((frame) => frame.type === "tabs")?.tabs).toContainEqual(
          expect.objectContaining({ tabId: 101, url }),
        ),
      );
      expect(harness.debuggerDetach).not.toHaveBeenCalled();
      harness.updateTab(101, { url, pendingUrl: undefined });
      expect(
        await harness.command({ type: "cdp", tabId: 101, method: "Runtime.evaluate" }),
      ).toMatchObject({ type: "result" });
      harness.updateTab(101, { url: "about:blank" });
      expect(await harness.command({ type: "attach", tabId: 101 })).toMatchObject({
        type: "error",
      });
      expect(await harness.command({ type: "closeTab", tabId: 101 })).toMatchObject({
        type: "error",
      });
      expect(harness.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it("fences commands and events immediately on a restricted pending destination", async () => {
    const harness = await createHarness(mode);
    await harness.command({ type: "createTab", url: "about:blank" });
    const commandResult = deferred<Record<string, never>>({});
    harness.debuggerSendCommand.mockImplementationOnce(async () => await commandResult.promise);
    const executing = harness.command({ type: "cdp", tabId: 101, method: "Runtime.evaluate" });
    await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
    harness.updateTab(101, { pendingUrl: "chrome://settings" });
    harness.debuggerEventListener?.({ tabId: 101 }, "Runtime.consoleAPICalled", {});
    expect(harness.frames().some((frame) => frame.type === "cdpEvent")).toBe(false);
    commandResult.resolve({});
    expect(await executing).toMatchObject({ type: "error" });
    expect(await harness.command({ type: "attach", tabId: 101 })).toMatchObject({ type: "error" });
  });

  it("finishes bootstrap when Chrome commits the original pending blank after handoff", async () => {
    const harness = await createHarness(mode);
    const create = harness.tabsCreate.getMockImplementation()!;
    harness.tabsCreate.mockImplementation(async (params) =>
      Object.assign(await create(params), { url: "", pendingUrl: "about:blank" }),
    );
    expect(await harness.command({ type: "createTab", url: "about:blank" })).toMatchObject({
      type: "result",
    });
    const initialized = deferred<Record<string, never>>({});
    harness.debuggerSendCommand.mockImplementationOnce(async () => await initialized.promise);
    const initializing = harness.command({ type: "cdp", tabId: 101, method: "Page.enable" });
    await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
    harness.updateTab(101, { url: "about:blank", pendingUrl: undefined });
    initialized.resolve();
    expect(await initializing).toMatchObject({ type: "result" });
    expect(await harness.command({ type: "closeTab", tabId: 101 })).toMatchObject({
      type: "result",
    });
  });

  it("does not publish or detach an owned target before focus completes", async () => {
    const harness = await createHarness(mode);
    const focusing = deferred(undefined);
    harness.windowsUpdate.mockImplementationOnce(async () => await focusing.promise);
    const creating = harness.command({ type: "createTab", url: "about:blank", focus: true });
    await vi.waitFor(() => expect(harness.windowsUpdate).toHaveBeenCalled());
    harness.updateTab(101, { url: "about:blank" });
    await vi.waitFor(() =>
      expect(harness.frames().findLast((frame) => frame.type === "tabs")?.tabs).toEqual([]),
    );
    expect(harness.debuggerDetach).not.toHaveBeenCalled();
    focusing.resolve();
    expect(await creating).toMatchObject({ type: "result" });
  });

  it("does not recapture creation authority from a late self-group event after revocation", async () => {
    const harness = await createHarness(mode);
    const naming = deferred(undefined);
    harness.tabGroupsUpdate.mockImplementationOnce(async () => await naming.promise);
    const creating = harness.command({ type: "createTab", url: "about:blank" });
    await vi.waitFor(() => expect(harness.tabGroupsUpdate).toHaveBeenCalled());
    await sendRuntimeMessage(harness, {
      type: "toggleTabAccess",
      tabId: 101,
      accessMode: mode,
      grant: false,
    });
    harness.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
    naming.resolve();
    expect(await creating).toMatchObject({ type: "error" });
    expect(harness.debuggerAttach).not.toHaveBeenCalled();
    expect(harness.tabsRemove).not.toHaveBeenCalled();
  });

  it("accepts its own group naming event after the Chrome API callback during attachment", async () => {
    const harness = await createHarness(mode);
    harness.tabGroupsUpdate.mockResolvedValueOnce(undefined);
    const attaching = deferred(undefined);
    harness.debuggerAttach.mockImplementationOnce(async () => await attaching.promise);
    const creating = harness.command({ type: "createTab", url: "about:blank" });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());
    harness.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
    attaching.resolve();
    expect(await creating).toMatchObject({ type: "result" });
    expect(harness.tabsRemove).not.toHaveBeenCalled();
  });

  it("keeps Pause/Allow or selected-group regrant coherent for the same initial document", async () => {
    const harness = await createHarness(mode);
    await harness.command({ type: "createTab", url: "about:blank" });
    for (const grant of [false, true]) {
      await expect(
        sendRuntimeMessage(harness, {
          type: "toggleTabAccess",
          tabId: 101,
          accessMode: mode,
          grant,
        }),
      ).resolves.toMatchObject({ ok: true, accessible: grant });
      expect(await harness.command({ type: "attach", tabId: 101 })).toMatchObject({
        type: grant ? "result" : "error",
      });
    }
  });

  it.each(["pause", "cancel", "group", "replacement", "removal"])(
    "fences an in-flight creation after %s without rolling back a taken-over tab",
    async (revocation) => {
      const harness = await createHarness(mode);
      const attaching = deferred(undefined);
      harness.debuggerAttach.mockImplementationOnce(async () => await attaching.promise);
      const creating = harness.command({ type: "createTab", url: "about:blank" });
      await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());
      let mutation: Promise<unknown> | undefined;
      switch (revocation) {
        case "pause":
          mutation = sendRuntimeMessage(harness, {
            type: "toggleTabAccess",
            tabId: 101,
            accessMode: mode,
            grant: false,
          });
          await vi.waitFor(async () =>
            expect(
              await sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 101 }),
            ).toMatchObject({ accessible: false }),
          );
          break;
        case "cancel":
          harness.debuggerDetachListener?.({ tabId: 101 }, "canceled_by_user");
          break;
        case "group":
          harness.updateTab(101, { groupId: -1 });
          break;
        case "replacement":
          harness.tabsReplacedListener(102, 101);
          harness.updateTab(102, { url: "about:blank", groupId: 7 });
          break;
        case "removal":
          harness.tabsRemovedListener?.(101);
          // Simulate a copied/reused id after the authoritative removal event.
          harness.updateTab(101, { url: "about:blank", groupId: 7 });
          break;
      }
      attaching.resolve();
      expect(await creating).toMatchObject({ type: "error" });
      await mutation;
      expect(harness.tabsRemove).not.toHaveBeenCalled();
      if (revocation === "cancel") {
        // Chrome's onDetach already destroyed this exact native client.
        expect(harness.debuggerDetach).not.toHaveBeenCalled();
      } else {
        expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-101" });
      }
      if (revocation === "replacement") {
        expect(await harness.command({ type: "attach", tabId: 102 })).toMatchObject({
          type: "error",
        });
      }
    },
  );

  it("does not restore initial provenance from group snapshots after worker restart", async () => {
    const harness = await createHarness(mode);
    await harness.command({ type: "createTab", url: "about:blank" });
    const initialTabs = await harness.tabsQuery();
    await cleanupBackgroundHarnesses();
    vi.resetModules();
    const restarted = await loadBackground({
      storedConfig: {
        ...harness.storageValues,
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: mode,
      },
      initialTabs,
    });
    await expect(
      sendRuntimeMessage(restarted, { type: "getTabAccess", tabId: 101 }),
    ).resolves.toMatchObject({ accessible: false, eligible: false });
  });

  it("preserves the original failure and reports failed rollback", async () => {
    const harness = await createHarness(mode);
    harness.tabsGroup.mockRejectedValueOnce(new Error("group failed"));
    harness.tabsRemove.mockRejectedValueOnce(new Error("remove failed"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await harness.command({ type: "createTab", url: "about:blank" })).toMatchObject({
        type: "error",
        message: "group failed; cleanup failed for created tab 101; close it manually.",
      });
      expect(warning).toHaveBeenCalledWith(
        "Cleanup failed for created tab 101; close it manually.",
      );
    } finally {
      warning.mockRestore();
    }
  });
});

describe("navigation command authority", () => {
  it("retires stale page data across a reload without a URL change", async () => {
    const harness = await createHarness("selected");
    await harness.command({ type: "createTab", url: "https://example.com/same" });
    const completed = deferred({});
    harness.debuggerSendCommand.mockImplementationOnce(async () => await completed.promise);
    const reading = harness.command({ type: "cdp", tabId: 101, method: "Runtime.evaluate" });
    await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
    harness.updateTab(101, { status: "loading" });
    completed.resolve();
    expect(await reading).toMatchObject({ type: "error" });
  });

  it.each([
    { mode: "all" as const, revocation: "group" },
    { mode: "selected" as const, revocation: "cancel" },
    { mode: "selected" as const, revocation: "replacement" },
    { mode: "selected" as const, revocation: "file" },
  ])(
    "rejects navigation completion after $revocation in $mode even if an ordinary document returns",
    async ({ mode, revocation }) => {
      const harness = await createHarness(mode);
      await harness.command({ type: "createTab", url: "about:blank" });
      const completed = deferred({});
      harness.debuggerSendCommand.mockImplementationOnce(async () => await completed.promise);
      const navigating = harness.command({
        type: "cdp",
        tabId: 101,
        method: "Page.navigate",
        params: { url: "https://example.com/next" },
      });
      await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
      harness.updateTab(101, { url: "https://example.com/next" });
      switch (revocation) {
        case "cancel":
          harness.debuggerDetachListener?.({ tabId: 101 }, "canceled_by_user");
          break;
        case "group":
          await sendRuntimeMessage(harness, { type: "setAccessMode", accessMode: "selected" });
          harness.updateTab(101, { groupId: -1 });
          break;
        case "replacement":
          harness.tabsReplacedListener(102, 101);
          break;
        case "file":
          harness.updateTab(101, { url: "file:///tmp/private.html" });
          break;
      }
      harness.updateTab(101, {
        url: "https://example.com/returned",
        pendingUrl: undefined,
        incognito: false,
      });
      completed.resolve();
      expect(await navigating).toMatchObject({ type: "error" });
      expect(harness.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it("never replies to navigation through a replacement socket", async () => {
    const harness = await createHarness("selected");
    await harness.command({ type: "createTab", url: "about:blank" });
    const completed = deferred({});
    let returned = false;
    harness.debuggerSendCommand.mockImplementationOnce(async () => {
      await completed.promise;
      returned = true;
      return {};
    });
    harness.socket.receive({
      type: "cdp",
      seq: 70,
      tabId: 101,
      method: "Page.navigate",
      params: { url: "https://example.com/next" },
    });
    await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
    const mutation = sendRuntimeMessage(harness, {
      type: "pair",
      accessMode: "selected",
      pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
    });
    await vi.waitFor(() => expect(harness.socket.close).toHaveBeenCalled());
    completed.resolve();
    await mutation;
    await vi.waitFor(() => expect(returned).toBe(true));
    {
      const socket = harness.relaySockets.at(-1)!;
      await harness.authenticate(socket);
      expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).some((f) => f.seq === 70)).toBe(
        false,
      );
    }
    expect(harness.frames().some((f) => f.seq === 70)).toBe(false);
  });
});
