import { afterEach, describe, expect, it, vi } from "vitest";
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

type CleanupFailureStage =
  | "marker_set"
  | "session_remove"
  | "retired_local_remove"
  | "marker_remove";

function cleanupStorage(params: {
  registry?: unknown;
  readError?: Error;
  failureStage?: CleanupFailureStage;
}) {
  let failureStage = params.failureStage;
  const localValues: Record<string, unknown> = {
    copilotDeviceIdentitiesV1: { device: "identity" },
    copilotDeviceTokensV1: { device: "token" },
    ...RETAINED_LOCAL,
    copilotSessionRegistryV1: params.registry,
  };
  const sessionValues: Record<string, unknown> = {
    copilotBrowserInstanceV1: "browser-instance",
    copilotPanelBindingsV1: { 7: "panel-binding" },
  };
  const localSet = vi.fn(async (values: Record<string, unknown>) => {
    if (failureStage === "marker_set") {
      throw new Error("marker set failed");
    }
    Object.assign(localValues, values);
  });
  const localRemove = vi.fn(async (keys: string[]) => {
    const stage = keys.includes(CUSTODY_BLOCKED_KEY) ? "marker_remove" : "retired_local_remove";
    if (failureStage === stage) {
      throw new Error(`${stage} failed`);
    }
    for (const key of keys) {
      delete localValues[key];
    }
  });
  const sessionRemove = vi.fn(async (keys: string[]) => {
    if (failureStage === "session_remove") {
      throw new Error("session remove failed");
    }
    for (const key of keys) {
      delete sessionValues[key];
    }
  });
  return {
    chromeApi: {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => {
            if (params.readError) {
              throw params.readError;
            }
            return Object.fromEntries(
              keys
                .filter((key) => Object.hasOwn(localValues, key))
                .map((key) => [key, localValues[key]]),
            );
          }),
          set: localSet,
          remove: localRemove,
        },
        session: { remove: sessionRemove },
      },
    },
    localRemove,
    localValues,
    setFailureStage: (next: CleanupFailureStage | undefined) => {
      failureStage = next;
    },
    sessionRemove,
    sessionValues,
  };
}

describe("retired copilot custody", () => {
  it("preserves every retired key when the registry read fails", async () => {
    const storage = cleanupStorage({ readError: new Error("storage unavailable") });
    const beforeLocal = structuredClone(storage.localValues);
    const beforeSession = structuredClone(storage.sessionValues);

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({ blocked: true });

    expect(storage.localRemove).not.toHaveBeenCalled();
    expect(storage.sessionRemove).not.toHaveBeenCalled();
    expect(storage.localValues).toEqual(beforeLocal);
    expect(storage.sessionValues).toEqual(beforeSession);
    expect(storage.localValues).toMatchObject(RETAINED_LOCAL);
  });

  it.each<CleanupFailureStage>([
    "marker_set",
    "session_remove",
    "retired_local_remove",
    "marker_remove",
  ])("keeps cleanup restart-safe when %s fails and an explicit retry finishes", async (stage) => {
    const storage = cleanupStorage({
      registry: { sessions: { 7: { creationPending: true } }, pendingArchives: [] },
      failureStage: stage,
    });

    await expect(discardRetiredCopilotState(storage.chromeApi)).rejects.toThrow("failed");
    if (stage === "marker_set") {
      expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");
      expect(storage.localValues).not.toHaveProperty(CUSTODY_BLOCKED_KEY);
    } else {
      expect(storage.localValues[CUSTODY_BLOCKED_KEY]).toBe(true);
    }
    if (stage === "session_remove") {
      expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");
    }
    if (stage === "marker_remove") {
      expect(storage.localValues).not.toHaveProperty("copilotSessionRegistryV1");
    }

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({
      blocked: true,
    });
    storage.setFailureStage(undefined);
    await expect(discardRetiredCopilotState(storage.chromeApi)).resolves.toBeUndefined();
    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
  });

  it("retries harmless cleanup after session removal fails", async () => {
    const storage = cleanupStorage({
      registry: { sessions: {}, pendingArchives: [] },
      failureStage: "session_remove",
    });

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({
      blocked: true,
    });
    expect(storage.localValues).not.toHaveProperty(CUSTODY_BLOCKED_KEY);
    expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");

    storage.setFailureStage(undefined);
    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({
      blocked: false,
    });
    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
  });
});

describe("native bootstrap timeout", () => {
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
      const stored: Record<string, unknown> = {};
      let onDisconnect = () => {};
      const disconnect = vi.fn(() => onDisconnect());
      const chromeApi = {
        runtime: {
          connectNative: vi.fn(() => ({
            disconnect,
            onDisconnect: {
              addListener: (listener: () => void) => {
                onDisconnect = listener;
              },
            },
            onMessage: { addListener: vi.fn() },
            postMessage: vi.fn(),
          })),
        },
        storage: {
          local: {
            get: vi.fn(async (keys: string[]) =>
              Object.fromEntries(
                keys.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]),
              ),
            ),
            set: vi.fn(async (values: Record<string, unknown>) => {
              Object.assign(stored, values);
            }),
            remove: vi.fn(async (keys: string[]) => {
              for (const key of keys) {
                delete stored[key];
              }
            }),
          },
        },
      };
      const controller = createNativeBootstrapController({
        chromeApi,
        getPairing: async () => null,
        applyPairing: vi.fn(),
      });

      const attempt = controller.attempt();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        chromeApi.runtime.connectNative.mock.results[0]?.value.postMessage,
      ).toHaveBeenCalledWith({
        v: 1,
        op: "bootstrap",
        nonce: "ABEiM0RVZneImaq7zN3u_w",
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(stored).toEqual({});
      if (ownership !== "current") {
        await controller.disableSynchronously();
        if (ownership === "re-enabled") {
          await controller.enable({ attemptNow: false });
        }
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
          : {
              disabled: ownership === "disabled",
              state: ownership === "disabled" ? "disabled" : "waiting",
            },
      );
      expect(disconnect).toHaveBeenCalledOnce();
    },
  );
});

type EnsurePortScript = (request: { nonce: string }) => unknown;

function ensureChromeApi(script: EnsurePortScript | "disconnect") {
  const connectNative = vi.fn(() => {
    let messageListener: ((response: unknown) => void) | undefined;
    let disconnectListener: (() => void) | undefined;
    return {
      disconnect: vi.fn(),
      onMessage: {
        addListener: (listener: (response: unknown) => void) => {
          messageListener = listener;
        },
      },
      onDisconnect: {
        addListener: (listener: () => void) => {
          disconnectListener = listener;
        },
      },
      postMessage: (request: { nonce: string }) => {
        queueMicrotask(() => {
          if (script === "disconnect") {
            disconnectListener?.();
            return;
          }
          messageListener?.(script(request));
        });
      },
    };
  });
  return { runtime: { connectNative, lastError: undefined } };
}

describe("requestRelayEnsure", () => {
  it("returns the relay status when the native host answers with the echoed nonce", async () => {
    const chromeApi = ensureChromeApi((request) => {
      expect(request).toEqual({
        v: 1,
        op: "ensure_relay",
        nonce: expect.any(String),
        relayPort: 20123,
      });
      return { v: 1, ok: true, nonce: request.nonce, relay: "spawned" };
    });
    await expect(requestRelayEnsure(20123, chromeApi)).resolves.toEqual({ status: "spawned" });
  });

  it("treats a nonce mismatch as unavailable", async () => {
    const chromeApi = ensureChromeApi(() => ({
      v: 1,
      ok: true,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      relay: "spawned",
    }));
    await expect(requestRelayEnsure(20123, chromeApi)).resolves.toEqual({ status: "unavailable" });
  });

  it("treats a missing native host as unavailable", async () => {
    await expect(requestRelayEnsure(20123, ensureChromeApi("disconnect"))).resolves.toEqual({
      status: "unavailable",
    });
  });
});
