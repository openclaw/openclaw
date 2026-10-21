import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectUnused,
  relayConfig,
  relayFrames,
  runtime,
  waitCalled,
} from "./background.lifecycle-test-helpers.js";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  REPLACEMENT_TEST_RELAY_KEY,
} from "./background.test-harness.js";

function load(
  accessMode: string,
  tabs: (number | { id: number; groupId: number })[] = [],
  options: Parameters<typeof loadBackground>[0] = {},
) {
  return loadBackground({
    storedConfig: relayConfig(accessMode),
    initialTabs: tabs.map((tab) => ({
      url: "https://example.com/",
      groupId: -1,
      ...(typeof tab === "number" ? { id: tab } : tab),
    })),
    ...options,
  });
}
async function ready(...args: Parameters<typeof load>) {
  const harness = await load(...args);
  const socket = harness.relaySockets[0];
  if (
    !socket ||
    !harness.debuggerEventListener ||
    !harness.debuggerDetachListener ||
    !harness.tabsRemovedListener ||
    !harness.tabGroupRemovedListener
  ) {
    throw new Error("expected relay and Chrome lifecycle listeners");
  }
  await harness.authenticate(socket);
  return Object.assign(harness, {
    socket,
    frames: () => relayFrames(socket),
    events: () => relayFrames(socket).filter((frame) => frame.type === "cdpEvent"),
    debuggerEventListener: harness.debuggerEventListener,
    debuggerDetachListener: harness.debuggerDetachListener,
    tabsRemovedListener: harness.tabsRemovedListener,
    tabGroupRemovedListener: harness.tabGroupRemovedListener,
  });
}

describe("relay command authorization", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    await cleanupBackgroundHarnesses();
    vi.unstubAllGlobals();
  });
  it("closes the old selected relay before a replacement pairing widens access", async () => {
    const harness = await ready("selected", [45]);
    const oldSocket = harness.socket;
    expect(
      await runtime(harness, "pair", {
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
        accessMode: "all",
      }),
    ).toEqual({ ok: true });
    expect(oldSocket.close).toHaveBeenCalledOnce();
    const oldFrames = relayFrames(oldSocket);
    expect(
      oldFrames.some(
        (frame) =>
          frame.type === "tabs" && frame.tabs?.some((tab: { tabId?: number }) => tab.tabId === 45),
      ),
    ).toBe(false);
    const replacement = harness.relaySockets.find(
      (socket) => socket.url === "ws://127.0.0.1:18798/extension",
    );
    if (!replacement) {
      throw new Error("expected replacement relay socket");
    }
    await harness.authenticate(replacement);
    const replacementHello = relayFrames(replacement).find((frame) => frame.type === "hello");
    expect(replacementHello.tabs).toContainEqual(expect.objectContaining({ tabId: 45 }));
  });
  it("waits for access initialization before toggling an all-mode tab", async () => {
    const harness = await load("all", [46], { deferTabAccessInitialization: true });
    harness.tabsGet.mockClear();
    const response = vi.fn();
    harness.messageListener(
      { type: "toggleTabAccess", tabId: 46, accessMode: "all", grant: false },
      {},
      response,
    );
    await Promise.resolve();
    await Promise.resolve();
    expectUnused(response, harness.tabsGet, harness.tabsGroup);
    harness.releaseTabAccessInitialization();
    await waitCalled(response, { ok: true, accessible: false, denied: true });
    expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([46]);
    expectUnused(harness.tabsGroup);
  });
  it("rejects a negative getTabAccess tab id without querying Chrome", async () => {
    const harness = await loadBackground();
    harness.tabsGet.mockClear();
    expect(await runtime(harness, "getTabAccess", { tabId: -1 })).toEqual({
      accessMode: "selected",
      accessible: false,
      eligible: false,
      denied: false,
    });
    expectUnused(harness.tabsGet);
  });
  it("revokes all-mode authority before a queued downgrade reaches the mutation queue", async () => {
    const harness = await ready("all", [204]);
    const socket = harness.socket;
    socket.receive({ type: "attach", seq: 40, tabId: 204 });
    await waitCalled(harness.debuggerAttach, { tabId: 204 }, "1.3");
    harness.storageSet.mockClear();
    socket.send.mockClear();
    const releaseOlderMutation = harness.deferNextStorageSet();
    const olderMutation = runtime(harness, "setAccessMode", { accessMode: "all" });
    await waitCalled(harness.storageSet, { accessMode: "all" });
    const downgrading = runtime(harness, "setAccessMode", { accessMode: "selected" });
    expect(await runtime(harness, "getTabAccess", { tabId: 204 })).toMatchObject({
      accessible: false,
    });
    harness.debuggerEventListener({ tabId: 204 }, "Runtime.consoleAPICalled", {});
    expect(harness.events()).toEqual([]);
    releaseOlderMutation();
    expect(await olderMutation).toEqual({ ok: true, accessMode: "all" });
    expect(await downgrading).toEqual({ ok: true, accessMode: "selected" });
    expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-204" });
  });
  it("rejects a stale tab action when a queued mode change executes first", async () => {
    const harness = await load("all", [205]);
    harness.storageSet.mockClear();
    const releaseModeStorage = harness.deferNextStorageSet();
    const changingMode = runtime(harness, "setAccessMode", { accessMode: "selected" });
    await waitCalled(harness.storageSet, { accessMode: "selected" });
    const staleToggle = runtime(harness, "toggleTabAccess", {
      tabId: 205,
      accessMode: "all",
      grant: false,
    });
    releaseModeStorage();
    expect(await changingMode).toEqual({ ok: true, accessMode: "selected" });
    expect(await staleToggle).toEqual({
      ok: false,
      error: "Browser access mode changed. Refresh and retry.",
    });
    expectUnused(harness.tabsGroup);
    expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
  });
  it("keeps a Selected barrier ahead of a queued All-mode widening", async () => {
    const harness = await load("selected", [206]);
    harness.storageSet.mockClear();
    const releaseWideningStorage = harness.deferNextStorageSet();
    const widening = runtime(harness, "setAccessMode", { accessMode: "all" });
    await waitCalled(harness.storageSet, { accessMode: "all" });
    const restricting = runtime(harness, "setAccessMode", { accessMode: "selected" });
    const releaseRestrictingStorage = harness.deferNextStorageSet();
    releaseWideningStorage();
    await waitCalled(harness.storageSet, { accessMode: "selected" });
    expect(await runtime(harness, "getTabAccess", { tabId: 206 })).toMatchObject({
      accessible: false,
    });
    releaseRestrictingStorage();
    expect(await widening).toEqual({ ok: true, accessMode: "all" });
    expect(await restricting).toEqual({ ok: true, accessMode: "selected" });
  });
  it("revalidates a selected survivor that leaves its group during downgrade cleanup", async () => {
    const harness = await ready("all", [{ id: 211, groupId: 7 }, 212]);
    const socket = harness.socket;
    socket.receive({ type: "attach", seq: 41, tabId: 211 });
    socket.receive({ type: "attach", seq: 42, tabId: 212 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalledTimes(2));
    const unselectedDetach = createDeferred<void>();
    harness.debuggerDetach.mockImplementation(async ({ targetId }) => {
      if (targetId === "tab-212") {
        await unselectedDetach.promise;
      }
    });
    socket.send.mockClear();
    const changingMode = runtime(harness, "setAccessMode", { accessMode: "selected" });
    await waitCalled(harness.debuggerDetach, { targetId: "tab-212" });
    harness.unshareTab(211);
    harness.tabsUpdatedListener(211, { groupId: -1 });
    unselectedDetach.resolve();
    expect(await changingMode).toEqual({ ok: true, accessMode: "selected" });
    await waitCalled(harness.debuggerDetach, { targetId: "tab-211" });
    harness.debuggerEventListener({ tabId: 211 }, "Runtime.consoleAPICalled", {});
    expect(harness.events()).toEqual([]);
  });
  it.each(["all", "selected"] as const)(
    "keeps an unrelated attachment live while toggling one tab in %s mode",
    async (accessMode) => {
      const groupId = accessMode === "selected" ? 7 : -1;
      const harness = await ready(
        accessMode,
        [201, 202].map((id) => ({ id, groupId })),
      );
      const socket = harness.socket;
      socket.receive({ type: "attach", seq: 28, tabId: 201 });
      socket.receive({ type: "attach", seq: 29, tabId: 202 });
      await vi.waitFor(() => {
        const frames = harness.frames();
        expect(frames).toContainEqual({
          type: "result",
          seq: 28,
          result: { targetId: "tab-201" },
        });
        expect(frames).toContainEqual({
          type: "result",
          seq: 29,
          result: { targetId: "tab-202" },
        });
      });
      socket.send.mockClear();
      let releaseMutation = () => {};
      if (accessMode === "all") {
        releaseMutation = harness.deferNextSessionStorageSet();
        harness.sessionStorageSet.mockClear();
      } else {
        const pendingDetach = new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
        harness.debuggerDetach.mockImplementation(async ({ targetId }) => {
          if (targetId === "tab-202") {
            await pendingDetach;
          }
        });
      }
      const toggling = runtime(harness, "toggleTabAccess", {
        tabId: 202,
        accessMode,
        grant: false,
      });
      if (accessMode === "all") {
        await waitCalled(harness.sessionStorageSet);
      } else {
        await waitCalled(harness.debuggerDetach, { targetId: "tab-202" });
      }
      expect(await runtime(harness, "getTabAccess", { tabId: 201 })).toMatchObject({
        accessible: true,
      });
      expect(await runtime(harness, "getTabAccess", { tabId: 202 })).toMatchObject({
        accessible: false,
      });
      const emitPhase = (phase: string) => {
        for (const tabId of [201, 202]) {
          harness.debuggerEventListener({ tabId }, "Runtime.consoleAPICalled", { phase });
        }
        return harness.events().map((frame) => frame.params?.phase);
      };
      expect(emitPhase("during")).toEqual(["during"]);
      releaseMutation();
      expect(await toggling).toEqual({
        ok: true,
        accessible: false,
        denied: accessMode === "all",
      });
      expect(emitPhase("after")).toEqual(["during", "after"]);
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-202" });
      expect(harness.debuggerDetach).not.toHaveBeenCalledWith({ targetId: "tab-201" });
      expect(harness.debuggerAttach).toHaveBeenCalledTimes(2);
    },
  );
  it("refreshes targets on selected-to-all while keeping session-denied tabs hidden", async () => {
    const harness = await ready("selected", [71, 72], { sessionConfig: { deniedTabIdsV1: [72] } });
    expect(await runtime(harness, "setAccessMode", { accessMode: "all" })).toMatchObject({
      ok: true,
      accessMode: "all",
    });
    await vi.waitFor(() => {
      const refreshes = harness.frames().filter((frame) => frame.type === "tabs");
      expect(refreshes.at(-1)?.tabs).toEqual([expect.objectContaining({ tabId: 71 })]);
    });
  });
  it("persists Cancel as an all-mode session deny, restores with Allow, and prunes on close", async () => {
    const harness = await ready("all", [81]);
    const socket = harness.socket;
    socket.receive({ type: "attach", seq: 30, tabId: 81 });
    await waitCalled(harness.debuggerAttach);
    harness.debuggerDetachListener({ tabId: 81 }, "canceled_by_user");
    await vi.waitFor(() => {
      expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([81]);
    });
    socket.receive({ type: "attach", seq: 31, tabId: 81 });
    await vi.waitFor(() => {
      const frames = harness.frames();
      expect(frames).toContainEqual({
        type: "error",
        seq: 31,
        message: "tab 81 is paused for OpenClaw",
      });
    });
    expect(
      await runtime(harness, "toggleTabAccess", { tabId: 81, accessMode: "all", grant: true }),
    ).toMatchObject({ ok: true, accessible: true, denied: false });
    expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
    harness.debuggerDetachListener({ tabId: 81 }, "canceled_by_user");
    await vi.waitFor(() => {
      expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([81]);
    });
    harness.tabsRemovedListener(81);
    await vi.waitFor(() => {
      expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
    });
  });
  it("revokes selected access on group removal", async () => {
    const harness = await ready("selected", [{ id: 111, groupId: 7 }]);
    harness.shareTab(111);
    harness.socket.receive({ type: "attach", seq: 34, tabId: 111 });
    await waitCalled(harness.debuggerAttach);
    harness.debuggerDetach.mockClear();
    harness.unshareTab(111);
    harness.tabGroupRemovedListener();
    await waitCalled(harness.debuggerDetach, { targetId: "tab-111" });
  });
});
