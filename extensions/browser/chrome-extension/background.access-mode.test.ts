import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  TEST_RELAY_KEY,
  REPLACEMENT_TEST_RELAY_KEY,
  sendRuntimeMessage,
} from "./background.test-harness.js";

const config = (accessMode: string) => ({
  relayUrl: "ws://127.0.0.1:18797/extension",
  token: TEST_RELAY_KEY,
  authVersion: 2,
  accessMode,
});

async function ready(options: Parameters<typeof loadBackground>[0] = {}) {
  const harness = await loadBackground(options);
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
    frames: () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw)),
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
    const harness = await ready({
      storedConfig: config("selected"),
      initialTabs: [{ id: 45, url: "https://example.com/private", groupId: -1 }],
    });
    const oldSocket = harness.socket;

    await expect(
      sendRuntimeMessage(harness, {
        type: "pair",
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
        accessMode: "all",
      }),
    ).resolves.toEqual({ ok: true });

    expect(oldSocket.close).toHaveBeenCalledOnce();
    const oldFrames = oldSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
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
    const replacementHello = replacement.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((frame) => frame.type === "hello");
    expect(replacementHello.tabs).toContainEqual(expect.objectContaining({ tabId: 45 }));
  });

  it("waits for access initialization before toggling an all-mode tab", async () => {
    const harness = await loadBackground({
      deferTabAccessInitialization: true,
      storedConfig: config("all"),
      initialTabs: [{ id: 46, url: "https://example.com/pending-init", groupId: -1 }],
    });
    harness.tabsGet.mockClear();
    const response = vi.fn();

    harness.messageListener(
      { type: "toggleTabAccess", tabId: 46, accessMode: "all", grant: false },
      {},
      response,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(response).not.toHaveBeenCalled();
    expect(harness.tabsGet).not.toHaveBeenCalled();
    expect(harness.tabsGroup).not.toHaveBeenCalled();
    harness.releaseTabAccessInitialization();
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({ ok: true, accessible: false, denied: true });
    });
    expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([46]);
    expect(harness.tabsGroup).not.toHaveBeenCalled();
  });

  it("rejects a negative getTabAccess tab id without querying Chrome", async () => {
    const harness = await loadBackground();
    harness.tabsGet.mockClear();
    await expect(sendRuntimeMessage(harness, { type: "getTabAccess", tabId: -1 })).resolves.toEqual(
      {
        accessMode: "selected",
        accessible: false,
        eligible: false,
        denied: false,
      },
    );
    expect(harness.tabsGet).not.toHaveBeenCalled();
  });

  it("revokes all-mode authority before a queued downgrade reaches the mutation queue", async () => {
    const harness = await ready({
      storedConfig: config("all"),
      initialTabs: [{ id: 204, url: "https://example.com/queued-downgrade", groupId: -1 }],
    });
    const socket = harness.socket;
    socket.receive({ type: "attach", seq: 40, tabId: 204 });
    await vi.waitFor(() =>
      expect(harness.debuggerAttach).toHaveBeenCalledWith({ tabId: 204 }, "1.3"),
    );

    harness.storageSet.mockClear();
    socket.send.mockClear();
    const releaseOlderMutation = harness.deferNextStorageSet();
    const olderMutation = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "all",
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "all" }));

    const downgrading = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    await expect(
      sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 204 }),
    ).resolves.toMatchObject({ accessible: false });
    harness.debuggerEventListener({ tabId: 204 }, "Runtime.consoleAPICalled", {});
    expect(
      socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .some((frame) => frame.type === "cdpEvent"),
    ).toBe(false);

    releaseOlderMutation();
    await expect(olderMutation).resolves.toEqual({ ok: true, accessMode: "all" });
    await expect(downgrading).resolves.toEqual({ ok: true, accessMode: "selected" });
    expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-204" });
  });

  it("rejects a stale tab action when a queued mode change executes first", async () => {
    const harness = await loadBackground({
      storedConfig: config("all"),
      initialTabs: [{ id: 205, url: "https://example.com/stale-action", groupId: -1 }],
    });
    harness.storageSet.mockClear();
    const releaseModeStorage = harness.deferNextStorageSet();
    const changingMode = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "selected" });
    });

    const staleToggle = sendRuntimeMessage(harness, {
      type: "toggleTabAccess",
      tabId: 205,
      accessMode: "all",
      grant: false,
    });
    releaseModeStorage();

    await expect(changingMode).resolves.toEqual({ ok: true, accessMode: "selected" });
    await expect(staleToggle).resolves.toEqual({
      ok: false,
      error: "Browser access mode changed. Refresh and retry.",
    });
    expect(harness.tabsGroup).not.toHaveBeenCalled();
    expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
  });

  it("keeps a Selected barrier ahead of a queued All-mode widening", async () => {
    const harness = await loadBackground({
      storedConfig: config("selected"),
      initialTabs: [{ id: 206, url: "https://example.com/queued-widening", groupId: -1 }],
    });
    harness.storageSet.mockClear();
    const releaseWideningStorage = harness.deferNextStorageSet();
    const widening = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "all",
    });
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "all" });
    });

    const restricting = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    const releaseRestrictingStorage = harness.deferNextStorageSet();
    releaseWideningStorage();
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "selected" });
    });

    await expect(
      sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 206 }),
    ).resolves.toMatchObject({ accessible: false });

    releaseRestrictingStorage();
    await expect(widening).resolves.toEqual({ ok: true, accessMode: "all" });
    await expect(restricting).resolves.toEqual({ ok: true, accessMode: "selected" });
  });

  it("revalidates a selected survivor that leaves its group during downgrade cleanup", async () => {
    const harness = await ready({
      storedConfig: config("all"),
      initialTabs: [
        { id: 211, url: "https://example.com/selected", groupId: 7 },
        { id: 212, url: "https://example.com/unselected", groupId: -1 },
      ],
    });
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
    const changingMode = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    await vi.waitFor(() =>
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-212" }),
    );

    harness.unshareTab(211);
    harness.tabsUpdatedListener(211, { groupId: -1 });
    unselectedDetach.resolve();

    await expect(changingMode).resolves.toEqual({ ok: true, accessMode: "selected" });
    await vi.waitFor(() =>
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-211" }),
    );
    harness.debuggerEventListener({ tabId: 211 }, "Runtime.consoleAPICalled", {});
    expect(
      socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .some((frame) => frame.type === "cdpEvent"),
    ).toBe(false);
  });

  it.each(["all", "selected"] as const)(
    "keeps an unrelated attachment live while toggling one tab in %s mode",
    async (accessMode) => {
      const groupId = accessMode === "selected" ? 7 : -1;
      const harness = await ready({
        storedConfig: config(accessMode),
        initialTabs: [
          { id: 201, url: "https://example.com/attached", groupId },
          { id: 202, url: "https://example.com/toggle", groupId },
        ],
      });
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
      const toggling = sendRuntimeMessage(harness, {
        type: "toggleTabAccess",
        tabId: 202,
        accessMode,
        grant: false,
      });
      if (accessMode === "all") {
        await vi.waitFor(() => expect(harness.sessionStorageSet).toHaveBeenCalled());
      } else {
        await vi.waitFor(() =>
          expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-202" }),
        );
      }

      await expect(
        sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 201 }),
      ).resolves.toMatchObject({ accessible: true });
      await expect(
        sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 202 }),
      ).resolves.toMatchObject({ accessible: false });
      harness.debuggerEventListener({ tabId: 201 }, "Runtime.consoleAPICalled", {
        phase: "during",
      });
      harness.debuggerEventListener({ tabId: 202 }, "Runtime.consoleAPICalled", {
        phase: "during",
      });
      expect(
        socket.send.mock.calls
          .map(([raw]) => JSON.parse(raw))
          .filter((frame) => frame.type === "cdpEvent")
          .map((frame) => frame.params?.phase),
      ).toEqual(["during"]);

      releaseMutation();
      await expect(toggling).resolves.toEqual({
        ok: true,
        accessible: false,
        denied: accessMode === "all",
      });

      harness.debuggerEventListener({ tabId: 201 }, "Runtime.consoleAPICalled", {
        phase: "after",
      });
      harness.debuggerEventListener({ tabId: 202 }, "Runtime.consoleAPICalled", {
        phase: "after",
      });
      expect(
        socket.send.mock.calls
          .map(([raw]) => JSON.parse(raw))
          .filter((frame) => frame.type === "cdpEvent")
          .map((frame) => frame.params?.phase),
      ).toEqual(["during", "after"]);
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-202" });
      expect(harness.debuggerDetach).not.toHaveBeenCalledWith({ targetId: "tab-201" });
      expect(harness.debuggerAttach).toHaveBeenCalledTimes(2);
    },
  );

  it("refreshes targets on selected-to-all while keeping session-denied tabs hidden", async () => {
    const harness = await ready({
      storedConfig: config("selected"),
      sessionConfig: { deniedTabIdsV1: [72] },
      initialTabs: [
        { id: 71, url: "https://example.com/available", groupId: -1 },
        { id: 72, url: "https://example.com/paused", groupId: -1 },
      ],
    });
    const socket = harness.socket;
    await expect(
      sendRuntimeMessage(harness, { type: "setAccessMode", accessMode: "all" }),
    ).resolves.toMatchObject({ ok: true, accessMode: "all" });

    await vi.waitFor(() => {
      const refreshes = socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((frame) => frame.type === "tabs");
      expect(refreshes.at(-1)?.tabs).toEqual([expect.objectContaining({ tabId: 71 })]);
    });
  });

  it("persists Cancel as an all-mode session deny, restores with Allow, and prunes on close", async () => {
    const harness = await ready({
      storedConfig: config("all"),
      initialTabs: [{ id: 81, url: "https://example.com/cancel", groupId: -1 }],
    });
    const socket = harness.socket;
    socket.receive({ type: "attach", seq: 30, tabId: 81 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());

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

    await expect(
      sendRuntimeMessage(harness, {
        type: "toggleTabAccess",
        tabId: 81,
        accessMode: "all",
        grant: true,
      }),
    ).resolves.toMatchObject({ ok: true, accessible: true, denied: false });
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
    const harness = await ready({
      storedConfig: config("selected"),
      initialTabs: [{ id: 111, url: "https://example.com/group", groupId: 7 }],
    });
    harness.shareTab(111);
    harness.socket.receive({ type: "attach", seq: 34, tabId: 111 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());
    harness.debuggerDetach.mockClear();
    harness.unshareTab(111);
    harness.tabGroupRemovedListener();
    await vi.waitFor(() =>
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-111" }),
    );
  });
});
