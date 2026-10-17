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
  sendRuntimeMessage,
} from "./background.test-harness.js";
import type { RetiredStorageFailureStage } from "./background.test-harness.js";

function nativeSuccess(request: unknown, secret = TEST_RELAY_KEY) {
  const nonce = (request as { nonce?: unknown }).nonce;
  return {
    v: 1,
    ok: true,
    nonce,
    pairingString: `ws://127.0.0.1:18797/extension?gateway=ws%3A%2F%2F127.0.0.1%3A18789#${secret}`,
  };
}

describe("native extension bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    await cleanupBackgroundHarnesses();
    vi.unstubAllGlobals();
  });
  it("recovers after a repaired manifest only when automatic setup is explicitly enabled again", async () => {
    let repaired = false;
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async (request) =>
        repaired ? nativeSuccess(request) : { v: 1, ok: false, code: "manifest_invalid" },
    });
    await vi.waitFor(() =>
      expect(harness.storageValues).toMatchObject({
        nativeBootstrapState: "manual_required",
        nativeBootstrapFailureCode: "manifest_invalid",
      }),
    );
    repaired = true;
    harness.alarmListener({ name: "openclaw-relay-watchdog" });
    await runtime(harness, "getStatus");
    expect(harness.sendNativeMessage).toHaveBeenCalledOnce();
    expect(harness.relaySockets).toHaveLength(0);
    expect(await runtime(harness, "setNativeBootstrapEnabled", { enabled: true })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(harness.relaySockets).toHaveLength(1));
    expect(harness.storageValues.nativeBootstrapState).toBe("ready");
    expect(harness.storageValues).not.toHaveProperty("nativeBootstrapFailureCode");
    expect(harness.sendNativeMessage).toHaveBeenCalledTimes(2);
    expect(harness.relaySockets[0]?.protocols).toEqual(["openclaw-extension-relay.v2"]);
    expect(JSON.stringify(harness.relaySockets[0]?.protocols)).not.toContain(TEST_RELAY_KEY);
  });
  it("coalesces startup, watchdog, and popup attempts", async () => {
    let resolveNative = (_value: unknown) => {};
    const pending = new Promise((resolve) => {
      resolveNative = resolve;
    });
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async (request) => {
        const response = await pending;
        return response ?? nativeSuccess(request);
      },
    });
    harness.alarmListener({ name: "openclaw-relay-watchdog" });
    const status = runtime(harness, "getStatus");
    expect(harness.sendNativeMessage).toHaveBeenCalledOnce();
    const request = harness.sendNativeMessage.mock.calls[0]?.[1];
    resolveNative(nativeSuccess(request));
    await status;
    expect(harness.sendNativeMessage).toHaveBeenCalledOnce();
  });
  it("does not overwrite a manual pairing that wins a native response race", async () => {
    let resolveNative = (_value: unknown) => {};
    let request: unknown;
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async (value) => {
        request = value;
        return await new Promise((resolve) => {
          resolveNative = resolve;
        });
      },
    });
    expect(
      await runtime(harness, "pair", {
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
        accessMode: "selected",
      }),
    ).toEqual({ ok: true });
    resolveNative(nativeSuccess(request));
    await vi.waitFor(() => expect(harness.relaySockets).toHaveLength(1));
    expect(harness.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18798/extension",
      token: REPLACEMENT_TEST_RELAY_KEY,
      accessMode: "selected",
    });
  });
  it("preserves opt-out across restart and manual pairing clears it", async () => {
    const harness = await loadBackground({
      storedConfig: { nativeBootstrapDisabled: true, nativeBootstrapState: "disabled" },
    });
    expectUnused(harness.sendNativeMessage);
    expect(
      await runtime(harness, "pair", {
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
      }),
    ).toEqual({ ok: true });
    expect(harness.storageValues).not.toHaveProperty("nativeBootstrapDisabled");
  });
  it.each([
    ["disable", "preflight"],
    ["unpair", "save"],
  ])("does not apply a native pairing overtaken by %s during %s", async (revocation, stage) => {
    let respond = (_value: unknown) => {};
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    });
    const readStorage = harness.storageGet.getMockImplementation()!;
    let releaseRead = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let pairingReads = 0;
    let saving = false;
    harness.storageGet.mockImplementation(async (keys) => {
      const result = await readStorage(keys);
      if (keys.includes("relayUrl") && ++pairingReads === 2 && stage === "preflight") {
        await blocked;
      }
      return result;
    });
    const writeStorage = harness.storageSet.getMockImplementation()!;
    harness.storageSet.mockImplementation(async (values) => {
      if (stage === "save" && values.relayUrl) {
        saving = true;
        await blocked;
      }
      await writeStorage(values);
    });
    respond(nativeSuccess(harness.sendNativeMessage.mock.calls[0]?.[1]));
    await vi.waitFor(() => expect(stage === "preflight" ? pairingReads === 2 : saving).toBe(true));
    const revoking = sendRuntimeMessage(
      harness,
      revocation === "unpair"
        ? { type: "unpair" }
        : { type: "setNativeBootstrapEnabled", enabled: false },
    );
    await vi.waitFor(() => expect(harness.storageValues.nativeBootstrapDisabled).toBe(true));
    releaseRead();
    expect(await revoking).toMatchObject({ ok: true });
    await runtime(harness, "getStatus");
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
    expect(harness.relaySockets).toHaveLength(0);
  });
  it("fails closed on a malformed or nonce-mismatched response", async () => {
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async () => ({
        v: 1,
        ok: true,
        nonce: "wrong",
        pairingString: `ws://127.0.0.1:18797/extension#${TEST_RELAY_KEY}`,
      }),
    });
    await vi.waitFor(() => {
      expect(harness.storageValues).toMatchObject({
        nativeBootstrapState: "manual_required",
        nativeBootstrapFailureCode: "malformed_response",
      });
    });
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
  });
  it("blocks every startup path while retired copilot custody is unresolved", async () => {
    const harness = await loadBackground({
      deferRetiredStatePreparation: true,
      inheritedDebuggerTabIds: [17],
      storedConfig: {
        ...relayConfig("all"),
        copilotSessionRegistryV1: {
          sessions: { 17: { creationPending: true } },
          pendingArchives: [],
        },
      },
    });
    harness.alarmListener({ name: "openclaw-relay-watchdog" });
    harness.startupListener();
    harness.installedListener();
    await Promise.resolve();
    expectUnused(harness.sendNativeMessage);
    expect(harness.relaySockets).toHaveLength(0);
    expectUnused(harness.debuggerAttach);
    harness.releaseRetiredStatePreparation();
    await waitCalled(harness.debuggerDetach, { targetId: "tab-17" });
    expectUnused(harness.sendNativeMessage);
    expect(harness.relaySockets).toHaveLength(0);
    const status = await runtime(harness, "getStatus");
    expect(status).toMatchObject({
      paired: true,
      retiredCopilotCustodyBlocked: true,
      accessibleTabCount: 0,
    });
    expect(JSON.stringify(status)).not.toMatch(/creationPending|pendingArchives|sessionKey/u);
    expect(
      await runtime(harness, "pair", {
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
      }),
    ).toMatchObject({ ok: false });
    expect(await runtime(harness, "setNativeBootstrapEnabled", { enabled: true })).toMatchObject({
      ok: false,
    });
    expect(await runtime(harness, "setAccessMode", { accessMode: "selected" })).toMatchObject({
      ok: false,
    });
    expect(
      await runtime(harness, "toggleTabAccess", { tabId: 17, accessMode: "all", grant: true }),
    ).toMatchObject({ ok: false });
    expect(harness.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18797/extension",
      accessMode: "all",
      copilotSessionRegistryV1: expect.any(Object),
    });
  });
  it.each<RetiredStorageFailureStage>(["marker_set", "session_remove", "retired_local_remove"])(
    "keeps custody blocked when Disconnect fails at %s and permits an explicit retry",
    async (stage) => {
      const harness = await loadBackground({
        inheritedDebuggerTabIds: [17],
        retiredStorageFailureStage: stage,
        storedConfig: {
          ...relayConfig("all"),
          copilotSessionRegistryV1: {
            sessions: { 17: { creationPending: true } },
            pendingArchives: [],
          },
        },
        sessionConfig: {
          copilotBrowserInstanceV1: "redacted",
          copilotPanelBindingsV1: { 17: "redacted" },
        },
      });
      expect(await runtime(harness, "unpair")).toMatchObject({
        ok: false,
      });
      expect(await runtime(harness, "getStatus")).toMatchObject({
        retiredCopilotCustodyBlocked: true,
      });
      expect(harness.relaySockets).toHaveLength(0);
      expectUnused(harness.sendNativeMessage, harness.debuggerAttach);
      if (stage === "marker_set") {
        expect(harness.storageValues).toHaveProperty("copilotSessionRegistryV1");
        expect(harness.storageValues).not.toHaveProperty("retiredCopilotCustodyBlockedV1");
      } else {
        expect(harness.storageValues.retiredCopilotCustodyBlockedV1).toBe(true);
      }
      if (stage === "session_remove" || stage === "retired_local_remove") {
        expect(harness.storageValues).toHaveProperty("copilotSessionRegistryV1");
      }
      harness.setRetiredStorageFailureStage(undefined);
      expect(await runtime(harness, "unpair")).toEqual({ ok: true });
      expect(harness.storageValues).not.toHaveProperty("retiredCopilotCustodyBlockedV1");
      expect(harness.storageValues).not.toHaveProperty("copilotSessionRegistryV1");
      expect(harness.sessionStorageValues).not.toHaveProperty("copilotBrowserInstanceV1");
      expect(harness.storageValues.nativeBootstrapDisabled).toBe(true);
      expect(harness.relaySockets).toHaveLength(0);
    },
  );
  it.each(["session_remove", "retired_local_remove"] as const)(
    "recovers on worker restart after harmless cleanup fails at %s",
    async (stage) => {
      const harness = await loadBackground({
        retiredStorageFailureStage: stage,
        storedConfig: {
          ...relayConfig("all"),
          copilotSessionRegistryV1: { sessions: {}, pendingArchives: [] },
        },
        sessionConfig: {
          copilotBrowserInstanceV1: "retired-instance",
          copilotPanelBindingsV1: { 17: "retired-binding" },
        },
      });
      expect(await runtime(harness, "getStatus")).toMatchObject({
        retiredCopilotCustodyBlocked: true,
      });
      expect(harness.relaySockets).toHaveLength(0);
      expectUnused(harness.debuggerAttach);
      const storedConfig = structuredClone(harness.storageValues);
      const sessionConfig = structuredClone(harness.sessionStorageValues);
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
    const harness = await loadBackground({
      inheritedDebuggerTabIds: [18],
      nativeMessage: async (request) => nativeSuccess(request),
      storedConfig: { ...relayConfig("all"), retiredCopilotCustodyBlockedV1: true },
    });
    await waitCalled(harness.debuggerDetach, { targetId: "tab-18" });
    expect(harness.relaySockets).toHaveLength(0);
    expectUnused(harness.sendNativeMessage, harness.debuggerAttach);
    expect(await runtime(harness, "getStatus")).toMatchObject({
      retiredCopilotCustodyBlocked: true,
      accessibleTabCount: 0,
    });
  });
});

describe("relay pairing and authentication", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    await cleanupBackgroundHarnesses();
    vi.unstubAllGlobals();
  });
  it("clears malformed persisted pairing before opening a relay", async () => {
    const harness = await loadBackground({
      storedConfig: { relayUrl: "ws://gateway.example/extension", token: TEST_RELAY_KEY },
    });
    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
  });
  it("cancels the opening deadline when the socket-close fallback ends the relay", async () => {
    const harness = await loadBackground({ relayNegotiatedProtocol: "unsupported" });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    harness.clearAlarm.mockClear();
    socket.close.mockImplementationOnce(() => {
      throw new Error("socket close failed");
    });
    socket.open();
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(2));
    expect(harness.clearAlarm).toHaveBeenCalledOnce();
  });
  it("revokes synchronously while an older manual pair is stalled", async () => {
    const harness = await loadBackground({
      initialTabs: [{ id: 131, url: "https://example.com/paired", groupId: 7 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    harness.storageSet.mockClear();
    const releaseSave = harness.deferNextStorageSet();
    const pairing = runtime(harness, "pair", {
      pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
      accessMode: "all",
    });
    await waitCalled(
      harness.storageSet,
      expect.objectContaining({ relayUrl: "ws://127.0.0.1:18798/extension" }),
    );
    const unpairing = runtime(harness, "unpair");
    expect(socket.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.storageValues.nativeBootstrapDisabled).toBe(true));
    releaseSave();
    expect(await pairing).toMatchObject({ ok: false });
    expect(await unpairing).toEqual({ ok: true });
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
  });
});

describe("standalone relay wake-up", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(async () => {
    await cleanupBackgroundHarnesses();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it.each([20123])(
    "wakes the paired port %i on reconnect, at most once per minute",
    async (relayPort) => {
      const harness = await loadBackground({
        storedConfig: { relayUrl: `ws://127.0.0.1:${relayPort}/extension`, token: TEST_RELAY_KEY },
        nativeMessage: async (request) => ({
          v: 1,
          ok: true,
          nonce: (request as { nonce: string }).nonce,
          relay: "spawned",
        }),
      });
      expectUnused(harness.sendNativeMessage);
      harness.relaySockets.at(-1)?.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(harness.sendNativeMessage).toHaveBeenCalledExactlyOnceWith(
        "ai.openclaw.browser_bootstrap",
        {
          v: 1,
          op: "ensure_relay",
          nonce: expect.any(String),
          relayPort,
        },
      );
      harness.relaySockets.at(-1)?.close();
      await vi.advanceTimersByTimeAsync(2000);
      expect(harness.relaySockets).toHaveLength(3);
      expect(harness.sendNativeMessage).toHaveBeenCalledOnce();
      vi.setSystemTime(Date.now() + 60_000);
      harness.relaySockets.at(-1)?.close();
      await vi.advanceTimersByTimeAsync(4000);
      expect(harness.sendNativeMessage).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    ["remote Gateway", "wss://gateway.example.com/browser/extension", false],
    ["automatic setup opt-out", "ws://127.0.0.1:18798/extension", true],
  ])("does not wake a daemon for %s", async (_label, relayUrl, nativeBootstrapDisabled) => {
    const harness = await loadBackground({
      storedConfig: { relayUrl, token: TEST_RELAY_KEY, nativeBootstrapDisabled },
    });
    await vi.waitFor(() => expect(harness.relaySockets).toHaveLength(1));
    harness.relaySockets.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.relaySockets).toHaveLength(2);
    expectUnused(harness.sendNativeMessage);
  });
});
