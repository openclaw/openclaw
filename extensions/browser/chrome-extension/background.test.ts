import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectUnused,
  connectRelay,
  loadConfiguredBackground as load,
  relayFrames,
  relayConfig,
  runtime,
  waitCalled,
} from "./background.lifecycle-test-helpers.js";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  TEST_RELAY_KEY,
  REPLACEMENT_TEST_RELAY_KEY,
} from "./background.test-harness.js";

const nativeSuccess = (request: unknown) => ({
  v: 1,
  ok: true,
  nonce: (request as { nonce?: unknown }).nonce,
  pairingString: `ws://127.0.0.1:18797/extension?gateway=ws%3A%2F%2F127.0.0.1%3A18789#${TEST_RELAY_KEY}`,
});

type Harness = Awaited<ReturnType<typeof loadBackground>>;
async function deferredNative() {
  const response = createDeferred<unknown>();
  const h = await loadBackground({ storedConfig: {}, nativeMessage: () => response.promise });
  return {
    h,
    respond: () => response.resolve(nativeSuccess(h.sendNativeMessage.mock.calls[0]?.[1])),
  };
}
const pair = (h: Harness, accessMode?: string) =>
  runtime(h, "pair", {
    pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
    ...(accessMode ? { accessMode } : {}),
  });
const retiredConfig = () => ({
  ...relayConfig("all"),
  copilotSessionRegistryV1: {
    sessions: { 17: { creationPending: true } },
    pendingArchives: [],
  },
});

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native extension bootstrap", () => {
  it("recovers after a repaired manifest only when automatic setup is explicitly enabled again", async () => {
    let repaired = false;
    const h = await loadBackground({
      storedConfig: {},
      nativeMessage: async (request) =>
        repaired ? nativeSuccess(request) : { v: 1, ok: false, code: "manifest_invalid" },
    });
    await vi.waitFor(() =>
      expect(h.storageValues).toMatchObject({
        nativeBootstrapState: "manual_required",
        nativeBootstrapFailureCode: "manifest_invalid",
      }),
    );
    repaired = true;
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    await runtime(h, "getStatus");
    expect(h.sendNativeMessage).toHaveBeenCalledOnce();
    expect(h.relaySockets).toHaveLength(0);
    expect(await runtime(h, "setNativeBootstrapEnabled", { enabled: true })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(1));
    expect(h.storageValues.nativeBootstrapState).toBe("ready");
    expect(h.storageValues).not.toHaveProperty("nativeBootstrapFailureCode");
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    expect(h.relaySockets[0]?.protocols).toEqual(["openclaw-extension-relay.v2"]);
    expect(JSON.stringify(h.relaySockets[0]?.protocols)).not.toContain(TEST_RELAY_KEY);
  });
  it("coalesces startup, watchdog, and popup attempts", async () => {
    const { h, respond } = await deferredNative();
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    const status = runtime(h, "getStatus");
    expect(h.sendNativeMessage).toHaveBeenCalledOnce();
    respond();
    await status;
    expect(h.sendNativeMessage).toHaveBeenCalledOnce();
  });
  it("does not overwrite a manual pairing that wins a native response race", async () => {
    const { h, respond } = await deferredNative();
    expect(await pair(h, "selected")).toEqual({ ok: true });
    respond();
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(1));
    expect(h.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18798/extension",
      token: REPLACEMENT_TEST_RELAY_KEY,
      accessMode: "selected",
    });
  });
  it("preserves opt-out across restart and manual pairing clears it", async () => {
    const h = await loadBackground({
      storedConfig: { nativeBootstrapDisabled: true, nativeBootstrapState: "disabled" },
    });
    expectUnused(h.sendNativeMessage);
    expect(await pair(h)).toEqual({ ok: true });
    expect(h.storageValues).not.toHaveProperty("nativeBootstrapDisabled");
  });
  it.each([
    ["disable", "preflight"],
    ["unpair", "save"],
  ])("does not apply a native pairing overtaken by %s during %s", async (revocation, stage) => {
    const { h, respond } = await deferredNative();
    const readStorage = h.storageGet.getMockImplementation()!;
    const blocked = createDeferred<void>();
    let pairingReads = 0;
    let saving = false;
    h.storageGet.mockImplementation(async (keys) => {
      const result = await readStorage(keys);
      if (keys.includes("relayUrl") && ++pairingReads === 2 && stage === "preflight") {
        await blocked.promise;
      }
      return result;
    });
    const writeStorage = h.storageSet.getMockImplementation()!;
    h.storageSet.mockImplementation(async (values) => {
      if (stage === "save" && values.relayUrl) {
        saving = true;
        await blocked.promise;
      }
      await writeStorage(values);
    });
    respond();
    await vi.waitFor(() => expect(stage === "preflight" ? pairingReads === 2 : saving).toBe(true));
    const revoking = runtime(
      h,
      revocation === "unpair" ? "unpair" : "setNativeBootstrapEnabled",
      revocation === "unpair" ? {} : { enabled: false },
    );
    await vi.waitFor(() => expect(h.storageValues.nativeBootstrapDisabled).toBe(true));
    blocked.resolve();
    expect(await revoking).toMatchObject({ ok: true });
    await runtime(h, "getStatus");
    expect(h.storageValues).not.toHaveProperty("relayUrl");
    expect(h.relaySockets).toHaveLength(0);
  });
  it("fails closed on a malformed or nonce-mismatched response", async () => {
    const h = await loadBackground({
      storedConfig: {},
      nativeMessage: async () => ({
        v: 1,
        ok: true,
        nonce: "wrong",
        pairingString: `ws://127.0.0.1:18797/extension#${TEST_RELAY_KEY}`,
      }),
    });
    await vi.waitFor(() =>
      expect(h.storageValues).toMatchObject({
        nativeBootstrapState: "manual_required",
        nativeBootstrapFailureCode: "malformed_response",
      }),
    );
    expect(h.storageValues).not.toHaveProperty("relayUrl");
  });
  it("blocks every startup path while retired copilot custody is unresolved", async () => {
    const h = await loadBackground({
      deferRetiredStatePreparation: true,
      inheritedDebuggerTabIds: [17],
      storedConfig: retiredConfig(),
    });
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    h.startupListener();
    h.installedListener();
    await Promise.resolve();
    expectUnused(h.sendNativeMessage, h.debuggerAttach);
    expect(h.relaySockets).toHaveLength(0);
    h.releaseRetiredStatePreparation();
    await waitCalled(h.debuggerDetach, { targetId: "tab-17" });
    expectUnused(h.sendNativeMessage);
    expect(h.relaySockets).toHaveLength(0);
    const status = await runtime(h, "getStatus");
    expect(status).toMatchObject({
      paired: true,
      retiredCopilotCustodyBlocked: true,
    });
    expect(JSON.stringify(status)).not.toMatch(/creationPending|pendingArchives|sessionKey/u);
    expect(await pair(h)).toMatchObject({ ok: false });
    expect(await runtime(h, "setNativeBootstrapEnabled", { enabled: true })).toMatchObject({
      ok: false,
    });
    expect(await runtime(h, "setAccessMode", { accessMode: "selected" })).toMatchObject({
      ok: false,
    });
    expect(
      await runtime(h, "toggleTabAccess", { tabId: 17, accessMode: "all", grant: true }),
    ).toMatchObject({ ok: false });
    expect(h.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18797/extension",
      accessMode: "all",
      copilotSessionRegistryV1: expect.any(Object),
    });
    expect(await runtime(h, "unpair")).toEqual({ ok: true });
    expect(h.storageValues).not.toHaveProperty("copilotSessionRegistryV1");
    expect(h.storageValues).not.toHaveProperty("retiredCopilotCustodyBlockedV1");
    expect(h.storageValues.nativeBootstrapDisabled).toBe(true);
  });
  it("keeps a persisted custody marker inert across worker startup without a registry", async () => {
    const h = await loadBackground({
      inheritedDebuggerTabIds: [18],
      nativeMessage: async (request) => nativeSuccess(request),
      storedConfig: { ...relayConfig("all"), retiredCopilotCustodyBlockedV1: true },
    });
    await waitCalled(h.debuggerDetach, { targetId: "tab-18" });
    expect(h.relaySockets).toHaveLength(0);
    expectUnused(h.sendNativeMessage, h.debuggerAttach);
    expect(await runtime(h, "getStatus")).toMatchObject({
      retiredCopilotCustodyBlocked: true,
    });
  });
});

describe("relay pairing and authentication", () => {
  it("clears malformed persisted pairing before opening a relay", async () => {
    const h = await loadBackground({
      storedConfig: { relayUrl: "ws://gateway.example/extension", token: TEST_RELAY_KEY },
    });
    expect(h.relaySockets).toHaveLength(0);
    expect(h.storageValues).not.toHaveProperty("relayUrl");
  });
  it("cancels the opening deadline when the socket-close fallback ends the relay", async () => {
    const h = await loadBackground({ relayNegotiatedProtocol: "unsupported" });
    const socket = h.relaySockets[0]!;
    expect(socket).toBeDefined();
    h.clearAlarm.mockClear();
    socket.close.mockImplementationOnce(() => {
      throw new Error("socket close failed");
    });
    socket.open();
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(2));
    expect(h.clearAlarm).toHaveBeenCalledOnce();
  });
  it("revokes synchronously while an older manual pair is stalled", async () => {
    const h = await loadBackground({
      initialTabs: [{ id: 131, url: "https://example.com/paired", groupId: 7 }],
    });
    const socket = h.relaySockets[0]!;
    expect(socket).toBeDefined();
    await h.authenticate(socket);
    h.storageSet.mockClear();
    const releaseSave = h.deferNextStorageSet();
    const pairing = pair(h, "all");
    await waitCalled(
      h.storageSet,
      expect.objectContaining({ relayUrl: "ws://127.0.0.1:18798/extension" }),
    );
    const unpairing = runtime(h, "unpair");
    expect(socket.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.storageValues.nativeBootstrapDisabled).toBe(true));
    releaseSave();
    expect(await pairing).toMatchObject({ ok: false });
    expect(await unpairing).toEqual({ ok: true });
    expect(h.storageValues).not.toHaveProperty("relayUrl");
  });
});

describe("standalone relay wake-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  it("wakes the paired port on reconnect, at most once per minute", async () => {
    const relayPort = 20123;
    const h = await loadBackground({
      storedConfig: { relayUrl: `ws://127.0.0.1:${relayPort}/extension`, token: TEST_RELAY_KEY },
      nativeMessage: async (request) => ({
        v: 1,
        ok: true,
        nonce: (request as { nonce: string }).nonce,
        relay: "spawned",
      }),
    });
    expectUnused(h.sendNativeMessage);
    h.relaySockets.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sendNativeMessage).toHaveBeenCalledExactlyOnceWith("ai.openclaw.browser_bootstrap", {
      v: 1,
      op: "ensure_relay",
      nonce: expect.any(String),
      relayPort,
    });
    h.relaySockets.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.relaySockets).toHaveLength(3);
    expect(h.sendNativeMessage).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 60_000);
    h.relaySockets.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["remote Gateway", "wss://gateway.example.com/browser/extension", false],
    ["automatic setup opt-out", "ws://127.0.0.1:18798/extension", true],
  ])("does not wake a daemon for %s", async (_label, relayUrl, nativeBootstrapDisabled) => {
    const h = await loadBackground({
      storedConfig: { relayUrl, token: TEST_RELAY_KEY, nativeBootstrapDisabled },
    });
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(1));
    h.relaySockets.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.relaySockets).toHaveLength(2);
    expectUnused(h.sendNativeMessage);
  });
});

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
    await vi.waitFor(() => expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([81]));
    expect(await harness.request({ type: "attach", tabId: 81 })).toEqual({
      type: "error",
      seq: expect.any(Number),
      message: "tab 81 is paused for OpenClaw",
    });
    expect(await toggle(harness, 81, "all", true)).toMatchObject({
      ok: true,
      accessible: true,
      denied: false,
    });
    expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
    harness.debuggerDetachListener({ tabId: 81 }, "canceled_by_user");
    await vi.waitFor(() => expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([81]));
    harness.tabsRemovedListener(81);
    await vi.waitFor(() =>
      expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1"),
    );
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
