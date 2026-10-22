import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectUnused,
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
import type { RetiredStorageFailureStage } from "./background.test-harness.js";

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
const retiredConfig = (pending = true) => ({
  ...relayConfig("all"),
  copilotSessionRegistryV1: {
    sessions: pending ? { 17: { creationPending: true } } : {},
    pendingArchives: [],
  },
});
const retiredSession = {
  copilotBrowserInstanceV1: "retired-instance",
  copilotPanelBindingsV1: { 17: "retired-binding" },
};

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
    expectUnused(h.sendNativeMessage);
    expect(h.relaySockets).toHaveLength(0);
    expectUnused(h.debuggerAttach);
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
  });
  it.each<RetiredStorageFailureStage>(["marker_set", "session_remove", "retired_local_remove"])(
    "keeps custody blocked when Disconnect fails at %s and permits an explicit retry",
    async (stage) => {
      const h = await loadBackground({
        inheritedDebuggerTabIds: [17],
        retiredStorageFailureStage: stage,
        storedConfig: retiredConfig(),
        sessionConfig: retiredSession,
      });
      expect(await runtime(h, "unpair")).toMatchObject({ ok: false });
      expect(await runtime(h, "getStatus")).toMatchObject({
        retiredCopilotCustodyBlocked: true,
      });
      expect(h.relaySockets).toHaveLength(0);
      expectUnused(h.sendNativeMessage, h.debuggerAttach);
      expect(h.storageValues).toHaveProperty("copilotSessionRegistryV1");
      if (stage === "marker_set") {
        expect(h.storageValues).not.toHaveProperty("retiredCopilotCustodyBlockedV1");
      } else {
        expect(h.storageValues.retiredCopilotCustodyBlockedV1).toBe(true);
      }
      h.setRetiredStorageFailureStage(undefined);
      expect(await runtime(h, "unpair")).toEqual({ ok: true });
      expect(h.storageValues).not.toHaveProperty("retiredCopilotCustodyBlockedV1");
      expect(h.storageValues).not.toHaveProperty("copilotSessionRegistryV1");
      expect(h.sessionStorageValues).not.toHaveProperty("copilotBrowserInstanceV1");
      expect(h.storageValues.nativeBootstrapDisabled).toBe(true);
      expect(h.relaySockets).toHaveLength(0);
    },
  );
  it.each(["session_remove", "retired_local_remove"] as const)(
    "recovers on worker restart after harmless cleanup fails at %s",
    async (stage) => {
      const h = await loadBackground({
        retiredStorageFailureStage: stage,
        storedConfig: retiredConfig(false),
        sessionConfig: retiredSession,
      });
      expect(await runtime(h, "getStatus")).toMatchObject({
        retiredCopilotCustodyBlocked: true,
      });
      expect(h.relaySockets).toHaveLength(0);
      expectUnused(h.debuggerAttach);
      const storedConfig = structuredClone(h.storageValues);
      const sessionConfig = structuredClone(h.sessionStorageValues);
      await cleanupBackgroundHarnesses();
      vi.resetModules();
      const restarted = await loadBackground({ storedConfig, sessionConfig });
      expect(await runtime(restarted, "getStatus")).toMatchObject({
        retiredCopilotCustodyBlocked: false,
        paired: true,
      });
      expect(restarted.relaySockets).toHaveLength(1);
      expect(restarted.storageValues).not.toHaveProperty("copilotSessionRegistryV1");
      expect(restarted.sessionStorageValues).not.toHaveProperty("copilotPanelBindingsV1");
    },
  );
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
  it.each([20123])(
    "wakes the paired port %i on reconnect, at most once per minute",
    async (relayPort) => {
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
    },
  );
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
