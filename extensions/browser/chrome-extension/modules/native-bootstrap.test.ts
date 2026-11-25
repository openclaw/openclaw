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

const cleanupStages = [
  "marker_set",
  "session_remove",
  "retired_local_remove",
  "marker_remove",
] as const;
type CleanupFailureStage = (typeof cleanupStages)[number];

type EnsurePortScript = (request: { nonce: string }) => unknown;

function nativePort(script?: EnsurePortScript | "disconnect") {
  const onMessage = chromeEvent<[unknown]>();
  const onDisconnect = chromeEvent<[]>();
  return {
    disconnect: vi.fn(() => onDisconnect.emit()),
    onMessage,
    onDisconnect,
    postMessage: vi.fn((request: { nonce: string }) => {
      if (script) {
        queueMicrotask(() => {
          if (script === "disconnect") {
            onDisconnect.emit();
          } else {
            onMessage.emit(script(request));
          }
        });
      }
    }),
  };
}

function cleanupStorage(params: { registry?: unknown; failureStage?: CleanupFailureStage }) {
  let failureStage = params.failureStage;
  const failAt = (stage: CleanupFailureStage) => {
    if (failureStage === stage) {
      throw new Error(`${stage} failed`);
    }
  };
  const local = storageArea(
    {
      ...RETAINED_LOCAL,
      copilotDeviceIdentitiesV1: { device: "identity" },
      copilotDeviceTokensV1: { device: "token" },
      copilotSessionRegistryV1: params.registry,
    },
    (operation, keys) => {
      if (operation === "get") {
        return;
      }
      const removal = keys.includes(CUSTODY_BLOCKED_KEY) ? "marker_remove" : "retired_local_remove";
      failAt(operation === "set" ? "marker_set" : removal);
    },
  );
  const session = storageArea(
    {
      copilotBrowserInstanceV1: "browser-instance",
      copilotPanelBindingsV1: { 7: "panel-binding" },
    },
    () => failAt("session_remove"),
  );
  const chromeApi = { storage: { local, session } };
  return {
    local,
    session,
    prepare: () => {
      vi.stubGlobal("chrome", chromeApi);
      return prepareRetiredCopilotState();
    },
    discard: () => {
      vi.stubGlobal("chrome", chromeApi);
      return discardRetiredCopilotState();
    },
    retry: () => {
      failureStage = undefined;
    },
    expectClean: () => {
      expect(local.values).toEqual(RETAINED_LOCAL);
      expect(session.values).toEqual({});
    },
  };
}

describe("retired copilot custody", () => {
  it("preserves every retired key when the registry read fails", async () => {
    const storage = cleanupStorage({});
    storage.local.get.mockRejectedValue(new Error("storage unavailable"));
    const beforeLocal = structuredClone(storage.local.values);
    const beforeSession = structuredClone(storage.session.values);

    await expect(storage.prepare()).resolves.toEqual({ blocked: true });

    expect(storage.local.remove).not.toHaveBeenCalled();
    expect(storage.session.remove).not.toHaveBeenCalled();
    expect(storage.local.values).toEqual(beforeLocal);
    expect(storage.session.values).toEqual(beforeSession);
  });

  it.each(cleanupStages)(
    "keeps cleanup restart-safe when %s fails and an explicit retry finishes",
    async (stage) => {
      const storage = cleanupStorage({
        registry: { sessions: { 7: { creationPending: true } }, pendingArchives: [] },
        failureStage: stage,
      });

      await expect(storage.discard()).rejects.toThrow("failed");
      if (stage === "marker_set") {
        expect(storage.local.values).toHaveProperty("copilotSessionRegistryV1");
        expect(storage.local.values).not.toHaveProperty(CUSTODY_BLOCKED_KEY);
      } else {
        expect(storage.local.values[CUSTODY_BLOCKED_KEY]).toBe(true);
      }
      if (stage === "session_remove") {
        expect(storage.local.values).toHaveProperty("copilotSessionRegistryV1");
      }
      if (stage === "marker_remove") {
        expect(storage.local.values).not.toHaveProperty("copilotSessionRegistryV1");
      }

      await expect(storage.prepare()).resolves.toEqual({ blocked: true });
      storage.retry();
      await expect(storage.discard()).resolves.toBeUndefined();
      storage.expectClean();
    },
  );

  it("retries harmless cleanup after session removal fails", async () => {
    const storage = cleanupStorage({
      registry: { sessions: {}, pendingArchives: [] },
      failureStage: "session_remove",
    });

    await expect(storage.prepare()).resolves.toEqual({ blocked: true });
    expect(storage.local.values).not.toHaveProperty(CUSTODY_BLOCKED_KEY);
    expect(storage.local.values).toHaveProperty("copilotSessionRegistryV1");

    storage.retry();
    await expect(storage.prepare()).resolves.toEqual({ blocked: false });
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

function ensureChromeApi(script: EnsurePortScript | "disconnect") {
  vi.stubGlobal("chrome", {
    runtime: { connectNative: vi.fn(() => nativePort(script)), lastError: undefined },
  });
}

describe("requestRelayEnsure", () => {
  it("settles the exact relay wake-up request after the native host answers", async () => {
    ensureChromeApi((request) => {
      expect(request).toEqual({
        v: 1,
        op: "ensure_relay",
        nonce: expect.any(String),
        relayPort: 20123,
      });
      return { v: 1, ok: true, nonce: request.nonce, relay: "spawned" };
    });
    await expect(requestRelayEnsure(20123)).resolves.toBeUndefined();
  });

  it("reports native disconnection to the reconnect owner's failure handler", async () => {
    ensureChromeApi("disconnect");
    await expect(requestRelayEnsure(20123)).rejects.toThrow("Native messaging host disconnected.");
  });
});
