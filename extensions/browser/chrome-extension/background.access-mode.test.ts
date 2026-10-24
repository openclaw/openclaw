import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectUnused,
  connectRelay,
  loadConfiguredBackground as load,
  relayFrames,
  runtime,
  waitCalled,
} from "./background.lifecycle-test-helpers.js";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  REPLACEMENT_TEST_RELAY_KEY,
} from "./background.test-harness.js";

type Harness = Awaited<ReturnType<typeof load>>;
const setMode = (h: Harness, accessMode: string) => runtime(h, "setAccessMode", { accessMode });
const toggle = (h: Harness, tabId: number, accessMode: string, grant = false) =>
  runtime(h, "toggleTabAccess", { tabId, accessMode, grant });
const expectMode = async (result: ReturnType<typeof setMode>, accessMode: string) =>
  expect(await result).toEqual({ ok: true, accessMode });
const expectAccess = async (h: Harness, tabId: number, accessible: boolean) =>
  expect(await runtime(h, "getTabAccess", { tabId })).toMatchObject({ accessible });

async function ready(...args: Parameters<typeof load>) {
  const harness = await load(...args);
  const connection = await connectRelay(harness);
  if (
    !harness.debuggerEventListener ||
    !harness.debuggerDetachListener ||
    !harness.tabsRemovedListener ||
    !harness.tabGroupRemovedListener
  ) {
    throw new Error("expected relay and Chrome lifecycle listeners");
  }
  return Object.assign(harness, {
    ...connection,
    events: () => connection.frames().filter((frame) => frame.type === "cdpEvent"),
    debuggerEventListener: harness.debuggerEventListener,
    debuggerDetachListener: harness.debuggerDetachListener,
    tabsRemovedListener: harness.tabsRemovedListener,
    tabGroupRemovedListener: harness.tabGroupRemovedListener,
  });
}

async function attach(h: Awaited<ReturnType<typeof ready>>, ...tabIds: number[]) {
  await Promise.all(
    tabIds.map(async (tabId) => {
      expect(await h.request({ type: "attach", tabId })).toMatchObject({
        type: "result",
        result: { targetId: `tab-${tabId}` },
      });
    }),
  );
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
    const olderMutation = setMode(harness, "all");
    await waitCalled(harness.storageSet, { accessMode: "all" });
    const downgrading = setMode(harness, "selected");
    await expectAccess(harness, 204, false);
    harness.debuggerEventListener({ tabId: 204 }, "Runtime.consoleAPICalled", {});
    expect(harness.events()).toEqual([]);
    releaseOlderMutation();
    await expectMode(olderMutation, "all");
    await expectMode(downgrading, "selected");
    expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-204" });
  });
  it("rejects a stale tab action when a queued mode change executes first", async () => {
    const harness = await load("all", [205]);
    harness.storageSet.mockClear();
    const releaseModeStorage = harness.deferNextStorageSet();
    const changingMode = setMode(harness, "selected");
    await waitCalled(harness.storageSet, { accessMode: "selected" });
    const staleToggle = toggle(harness, 205, "all");
    releaseModeStorage();
    await expectMode(changingMode, "selected");
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
    const widening = setMode(harness, "all");
    await waitCalled(harness.storageSet, { accessMode: "all" });
    const restricting = setMode(harness, "selected");
    const releaseRestrictingStorage = harness.deferNextStorageSet();
    releaseWideningStorage();
    await waitCalled(harness.storageSet, { accessMode: "selected" });
    await expectAccess(harness, 206, false);
    releaseRestrictingStorage();
    await expectMode(widening, "all");
    await expectMode(restricting, "selected");
  });
  it("revalidates a selected survivor that leaves its group during downgrade cleanup", async () => {
    const harness = await ready("all", [{ id: 211, groupId: 7 }, 212]);
    await attach(harness, 211, 212);
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalledTimes(2));
    const unselectedDetach = createDeferred<void>();
    harness.debuggerDetach.mockImplementation(async ({ targetId }) => {
      if (targetId === "tab-212") {
        await unselectedDetach.promise;
      }
    });
    harness.socket.send.mockClear();
    const changingMode = setMode(harness, "selected");
    await waitCalled(harness.debuggerDetach, { targetId: "tab-212" });
    harness.unshareTab(211);
    harness.tabsUpdatedListener(211, { groupId: -1 });
    unselectedDetach.resolve();
    await expectMode(changingMode, "selected");
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
      await attach(harness, 201, 202);
      harness.socket.send.mockClear();
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
      const toggling = toggle(harness, 202, accessMode);
      if (accessMode === "all") {
        await waitCalled(harness.sessionStorageSet);
      } else {
        await waitCalled(harness.debuggerDetach, { targetId: "tab-202" });
      }
      await expectAccess(harness, 201, true);
      await expectAccess(harness, 202, false);
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
    await expectMode(setMode(harness, "all"), "all");
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
    expect(await toggle(harness, 81, "all", true)).toMatchObject({
      ok: true,
      accessible: true,
      denied: false,
    });
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
