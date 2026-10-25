import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeEvent, storageArea } from "./browser.test-support.js";
import {
  createNativeBootstrapController,
  discardRetiredCopilotState,
  prepareRetiredCopilotState,
  requestRelayEnsure,
} from "./native-bootstrap.js";

const CUSTODY_BLOCKED_KEY = "retiredCopilotCustodyBlockedV1";
const RETAINED_LOCAL = {
  relayUrl: "ws://127.0.0.1:18789/extension",
  token: "test-relay-key",
  accessMode: "selected",
  deniedTabIdsV1: [7],
  nativeBootstrapDisabled: true,
};

function nativePort(disconnectOnPost = false) {
  const onMessage = chromeEvent<[unknown]>();
  const onDisconnect = chromeEvent<[]>();
  return {
    disconnect: vi.fn(() => onDisconnect.emit()),
    onMessage,
    onDisconnect,
    postMessage: vi.fn(() => {
      if (disconnectOnPost) {
        queueMicrotask(() => onDisconnect.emit());
      }
    }),
  };
}

function cleanupStorage(registry?: unknown, failOnMarkerRemoval = false) {
  let failMarkerRemoval = failOnMarkerRemoval;
  const local = storageArea(
    {
      ...RETAINED_LOCAL,
      copilotDeviceIdentitiesV1: { device: "identity" },
      copilotDeviceTokensV1: { device: "token" },
      copilotSessionRegistryV1: registry,
    },
    (operation, keys) => {
      if (failMarkerRemoval && operation === "remove" && keys.includes(CUSTODY_BLOCKED_KEY)) {
        throw new Error("marker removal failed");
      }
    },
  );
  const session = storageArea({
    copilotBrowserInstanceV1: "browser-instance",
    copilotPanelBindingsV1: { 7: "panel-binding" },
  });
  const chromeApi = { storage: { local, session } };
  vi.stubGlobal("chrome", chromeApi);
  return {
    local,
    session,
    prepare: prepareRetiredCopilotState,
    discard: discardRetiredCopilotState,
    retry: () => {
      failMarkerRemoval = false;
    },
    expectClean: () => {
      expect(local.values).toEqual(RETAINED_LOCAL);
      expect(session.values).toEqual({});
    },
  };
}

describe("retired copilot custody", () => {
  it("preserves every retired key when the registry read fails", async () => {
    const storage = cleanupStorage();
    storage.local.get.mockRejectedValue(new Error("storage unavailable"));
    const beforeLocal = structuredClone(storage.local.values);
    const beforeSession = structuredClone(storage.session.values);

    await expect(storage.prepare()).resolves.toEqual({ blocked: true });

    expect(storage.local.values).toEqual(beforeLocal);
    expect(storage.session.values).toEqual(beforeSession);
  });

  it("keeps custody blocked when final marker removal fails until explicit retry", async () => {
    const registry = { sessions: { 7: { creationPending: true } }, pendingArchives: [] };
    const storage = cleanupStorage(registry, true);
    await expect(storage.discard()).rejects.toThrow("failed");
    expect(storage.local.values[CUSTODY_BLOCKED_KEY]).toBe(true);
    expect(storage.local.values).not.toHaveProperty("copilotSessionRegistryV1");
    await expect(storage.prepare()).resolves.toEqual({ blocked: true });
    storage.retry();
    await expect(storage.discard()).resolves.toBeUndefined();
    storage.expectClean();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["current", "re-enabled"])(
  "settles a stuck native call after %s ownership",
  async (ownership) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", {
      getRandomValues: vi.fn((bytes: Uint8Array) => {
        bytes.set(Uint8Array.from({ length: 16 }, (_, index) => index * 17));
        return bytes;
      }),
    });
    const local = storageArea();
    const port = nativePort();
    const chromeApi = {
      runtime: { connectNative: vi.fn(() => port) },
      storage: { local },
    };
    vi.stubGlobal("chrome", chromeApi);
    const controller = createNativeBootstrapController({
      getPairing: async () => null,
      applyPairing: vi.fn(),
    });

    const attempt = controller.attempt();
    await vi.advanceTimersByTimeAsync(0);
    expect(port.postMessage).toHaveBeenCalledWith({
      v: 1,
      op: "bootstrap",
      nonce: "ABEiM0RVZneImaq7zN3u_w",
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(local.values).toEqual({});
    if (ownership !== "current") {
      await controller.disableSynchronously();
      await controller.enable({ attemptNow: false });
    }
    await vi.advanceTimersByTimeAsync(1);

    await expect(attempt).resolves.toEqual(
      ownership === "current"
        ? { status: "retrying", code: "native_host_timeout" }
        : { status: "superseded" },
    );
    await expect(controller.status()).resolves.toEqual(
      ownership === "current"
        ? { disabled: false, state: "retrying", failureCode: "native_host_timeout" }
        : { disabled: false, state: "waiting" },
    );
    expect(port.disconnect).toHaveBeenCalledOnce();
  },
);

it("reports native disconnection to the reconnect owner", async () => {
  vi.stubGlobal("chrome", {
    runtime: { connectNative: vi.fn(() => nativePort(true)), lastError: undefined },
  });
  await expect(requestRelayEnsure(20123)).rejects.toThrow("Native messaging host disconnected.");
});
