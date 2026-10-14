import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";

const config = (accessMode: "all" | "selected") => ({
  relayUrl: "ws://127.0.0.1:18797/extension",
  token: TEST_RELAY_KEY,
  authVersion: 2,
  accessMode,
});

async function setup(mode: "all" | "selected" = "all", deferSocketClose = false) {
  const harness = await loadBackground({
    storedConfig: config(mode),
    deferSocketClose,
    initialTabs: [
      { id: 100, url: "https://example.com/unrelated", groupId: 7 },
      { id: 99, url: "about:blank", groupId: 7 },
    ],
  });
  const socket = harness.relaySockets[0];
  assert(socket);
  await harness.authenticate(socket);
  let seq = 1000;
  const frames = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
  const request = async (message: Record<string, unknown>) => {
    const id = ++seq;
    socket.receive({ ...message, seq: id });
    await vi.waitFor(() => expect(frames().find((frame) => frame.seq === id)).toBeDefined());
    return frames().find((frame) => frame.seq === id);
  };
  // Exercise real policy/events with Chrome's full Tab observations, including
  // grouping events that arrive before the grouping API resolves.
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
  const create = async (url = "about:blank") => {
    expect(await request({ type: "createTab", url, background: true })).toMatchObject({
      type: "result",
      result: { tabId: 101 },
    });
  };
  const attach = async () => {
    expect(await request({ type: "attach", tabId: 101 })).toMatchObject({ type: "result" });
  };
  return Object.assign(harness, { socket, request, frames, create, attach });
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
      expect(await h.request({ type: "createTab", url: "about:blank" })).toMatchObject({
        type: observation === "initial blank" ? "result" : "error",
      });
      expect(h.tabsRemove).not.toHaveBeenCalled();
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
    expect(
      await h.request({ type: "createTab", url: "https://example.com/destination" }),
    ).toMatchObject({ type: "error", message: "created tab is no longer available" });
    expect(h.debuggerAttach).not.toHaveBeenCalled();
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });

  it.each(["initial loading snapshot", "same-group update"] as const)(
    "preserves selected navigation when the %s arrives after its root commit",
    async (event) => {
      const h = await setup("selected");
      await h.create();
      await h.attach();
      const url = "https://example.com/destination";
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        h.updateTab(101, { pendingUrl: url }, false);
        const initialLoadingTab = await h.tabsGet(101);
        h.updateTab(101, { url, pendingUrl: undefined }, false);
        h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
          frame: { id: "main", loaderId: "destination", url },
        });
        if (event === "initial loading snapshot") {
          h.tabsUpdatedListener?.(101, { status: "loading" }, initialLoadingTab);
        } else {
          const tab = { ...initialLoadingTab, url, pendingUrl: undefined };
          h.tabsUpdatedListener?.(101, { groupId: tab.groupId }, tab);
        }
        return { frameId: "main", loaderId: "destination" };
      });
      const response = await h.request({
        type: "cdp",
        tabId: 101,
        method: "Page.navigate",
        params: { url },
      });
      expect(response, JSON.stringify(response)).toMatchObject({
        type: "result",
        result: { frameId: "main", loaderId: "destination" },
      });
      expect(h.debuggerDetach).not.toHaveBeenCalled();
    },
  );

  it("keeps loading-snapshot authority revoked after group removal and restoration", async () => {
    const h = await setup("selected");
    await h.create();
    await h.attach();
    const url = "https://example.com/destination";
    const initialLoadingTab = { ...(await h.tabsGet(101)), pendingUrl: url };
    h.updateTab(101, { url }, false);
    h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
      frame: { id: "main", loaderId: "destination", url },
    });
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      h.updateTab(101, { groupId: -1 });
      h.updateTab(101, { groupId: 7 });
      h.tabsUpdatedListener?.(101, { status: "loading" }, initialLoadingTab);
      return { frameId: "main", loaderId: "destination" };
    });
    const response = await h.request({
      type: "cdp",
      tabId: 101,
      method: "Page.navigate",
      params: { url },
    });
    expect(response, JSON.stringify(response)).toMatchObject({
      type: "error",
      message: expect.stringMatching(
        /access was revoked|restricted or unavailable|Debugger attachment retired/,
      ),
    });
    expect(h.debuggerSendCommand).toHaveBeenCalledWith({ tabId: 101 }, "Page.navigate", { url });
  });

  it("restores fresh attachment authority without reviving a command admitted before a title change", async () => {
    const h = await setup("selected");
    h.tabGroupsUpdate.mockResolvedValueOnce(undefined);
    await h.create();
    await h.attach();
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      h.tabGroupUpdatedListener?.({ id: 7, title: "Other" });
      h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
      return { frameId: "main" };
    });

    expect(
      await h.request({
        type: "cdp",
        tabId: 101,
        method: "Page.navigate",
        params: { url: "https://example.com/destination" },
      }),
    ).toMatchObject({
      type: "error",
      message: expect.stringContaining("access was revoked"),
    });

    await vi.waitFor(() => {
      h.debuggerEventListener?.({ tabId: 101 }, "Runtime.consoleAPICalled", { value: 1 });
      expect(
        h
          .frames()
          .some(
            (frame) => frame.type === "cdpEvent" && frame.method === "Runtime.consoleAPICalled",
          ),
      ).toBe(true);
    });
    expect(await h.request({ type: "cdp", tabId: 101, method: "Runtime.enable" })).toMatchObject({
      type: "result",
    });
  });

  it("revokes group access during creation on removal", async () => {
    const h = await setup("selected");
    h.tabGroupsUpdate.mockImplementationOnce(async () => {
      h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
      h.tabGroupRemovedListener?.({ id: 7, title: "OpenClaw" });
    });
    expect(await h.request({ type: "createTab", url: "about:blank" })).toMatchObject({
      type: "error",
    });
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });

  it("leaves a revoked Selected tab alone when the group lookup beats its event", async () => {
    const h = await setup("selected");
    h.tabGroupsUpdate.mockImplementationOnce(async () => {
      h.tabGroupsGet.mockResolvedValue({ id: 7, title: "Other", windowId: 1 });
    });
    expect(await h.request({ type: "createTab", url: "about:blank" })).toMatchObject({
      type: "error",
    });
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });

  it.each(["removed", "pause"] as const)(
    "rechecks %s after the failure-cleanup lookup yields",
    async (reason) => {
      const h = await setup();
      const lookup = createDeferred<Awaited<ReturnType<typeof h.tabsGet>>>();
      releases.push(() =>
        lookup.resolve({
          id: 101,
          url: "about:blank",
          groupId: 7,
          windowId: 1,
          title: "",
          incognito: false,
        }),
      );
      let inspectingCleanup = false;
      h.debuggerAttach.mockImplementationOnce(async () => {
        h.tabsGet.mockImplementationOnce(async () => {
          inspectingCleanup = true;
          return await lookup.promise;
        });
        throw new Error("attach failed");
      });
      const attaching = h.request({ type: "createTab", url: "about:blank" });
      await vi.waitFor(() => expect(inspectingCleanup).toBe(true));
      let pausing: Promise<unknown> | undefined;
      if (reason === "removed") {
        h.tabsRemovedListener?.(101);
      } else {
        pausing = sendRuntimeMessage(h, {
          type: "toggleTabAccess",
          accessMode: "all",
          tabId: 101,
          grant: false,
        });
        await vi.waitFor(() => expect(h.sessionStorageValues.deniedTabIdsV1).toEqual([101]));
      }
      lookup.resolve(await h.tabsGet(101));
      await pausing;
      expect(await attaching).toMatchObject({ type: "error", message: "attach failed" });
      expect(h.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it.each(["selected"] as const)(
    "fences a %s revoke while grouping and leaves the user tab alone",
    async (mode) => {
      const h = await setup(mode);
      const deferred = createDeferred<number>();
      releases.push(() => deferred.resolve(7));
      const group = h.tabsGroup.getMockImplementation()!;
      h.tabsGroup.mockImplementationOnce(async (properties) => {
        await group(properties);
        return await deferred.promise;
      });
      const creating = h.request({ type: "createTab", url: "about:blank", focus: true });
      await vi.waitFor(() => expect(h.tabsGroup).toHaveBeenCalled());
      const revoke = sendRuntimeMessage(h, {
        type: "toggleTabAccess",
        accessMode: mode,
        tabId: 101,
        grant: false,
      });
      await expect(revoke).resolves.toMatchObject({ ok: true });
      deferred.resolve(7);
      expect(await creating).toMatchObject({
        type: "error",
        message: expect.stringMatching(/revoked/),
      });
      expect(h.windowsUpdate).not.toHaveBeenCalled();
      expect(h.tabsRemove).not.toHaveBeenCalled();
      expect(await h.request({ type: "attach", tabId: 101 })).toMatchObject({ type: "error" });
    },
  );
});
