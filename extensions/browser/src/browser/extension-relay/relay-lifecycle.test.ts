import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import { resolveProfile, type ResolvedBrowserConfig } from "../config.js";
import { refreshResolvedBrowserConfigFromDisk } from "../resolved-config-refresh.js";
import {
  beginProfileTransition,
  getOrCreateProfileRuntime,
  getProfileLifecycle,
  withProfileOperationLease,
} from "../server-context.lifecycle.js";
import type { BrowserServerState } from "../server-context.types.js";
import type { ExtensionRelayHandle } from "./relay-server.js";

const ensureToken = vi.fn();
vi.mock("./relay-auth.js", () => ({ ensureExtensionRelayToken: () => ensureToken() }));

vi.mock("../config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => ({
    browser: { profiles: { chrome: { driver: "extension", cdpPort: RELAY_PORT } } },
  }),
}));

const startRelay = vi.fn();
vi.mock("./relay-server.js", () => ({
  startExtensionRelayServer: (...args: unknown[]) => startRelay(...args),
}));

import { ensureExtensionRelayForProfile as ensureRelay } from "./relay-lifecycle.js";

const OLD_TOKEN = relayTestKey(1);
const ROTATED_TOKEN = relayTestKey(2);

const PROFILE_NAME = "chrome";
const RELAY_PORT = 18_123;

function createState(existing?: ExtensionRelayHandle) {
  const resolved = {
    extensionRelayToken: OLD_TOKEN,
    extensionRelay: { allowLegacyAuth: true },
    extensionRelayInternalTokens: existing ? { [PROFILE_NAME]: existing.internalToken } : {},
    profiles: { [PROFILE_NAME]: { cdpPort: RELAY_PORT, driver: "extension" } },
  } as unknown as ResolvedBrowserConfig;
  const state: BrowserServerState = {
    server: null,
    port: 0,
    resolved,
    profiles: new Map(),
    ...(existing ? { extensionRelays: new Map([[PROFILE_NAME, existing]]) } : {}),
  };
  const profile = resolveProfile(resolved, PROFILE_NAME);
  if (!profile) {
    throw new Error("expected extension profile");
  }
  return { profile, state };
}

function createHandle(token: string, port = RELAY_PORT): ExtensionRelayHandle {
  return {
    ownership: "owned",
    port,
    token,
    allowLegacyAuth: true,
    internalToken: `${token.slice(0, 8)}-internal`,
    bridge: {} as ExtensionRelayHandle["bridge"],
    close: vi.fn(async () => {}),
  };
}

function pendingRebind() {
  const oldRelay = createHandle(OLD_TOKEN);
  const { profile, state } = createState(oldRelay);
  const runtime = getOrCreateProfileRuntime(state, profile);
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const replacement = createHandle(ROTATED_TOKEN);
  startRelay.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return replacement;
  });
  const lease = (signal?: AbortSignal) =>
    withProfileOperationLease({
      state,
      runtime,
      signal,
      run: async (leaseSignal) => await ensureRelay(state, profile, leaseSignal),
    });
  return { oldRelay, profile, state, runtime, started, release, replacement, lease };
}

describe("extension relay lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureToken.mockResolvedValue(ROTATED_TOKEN);
    startRelay.mockImplementation(async ({ port, token, allowLegacyAuth }) => ({
      ...createHandle(token, port),
      allowLegacyAuth,
      internalToken: "replacement-internal",
    }));
  });

  it("retains and retries the exact stale relay when its first close fails", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    vi.mocked(oldRelay.close)
      .mockRejectedValueOnce(new Error("relay still listening"))
      .mockResolvedValue(undefined);
    const { profile, state } = createState(oldRelay);

    await expect(ensureRelay(state, profile)).rejects.toThrow("relay still listening");

    const runtime = state.profiles.get(profile.name);
    expect(runtime && getProfileLifecycle(runtime).blockedReason).toBeNull();
    expect(startRelay).not.toHaveBeenCalled();
    expect(state.extensionRelays?.get(profile.name)).toBe(oldRelay);

    await expect(ensureRelay(state, profile)).resolves.toMatchObject({ token: ROTATED_TOKEN });
    expect(oldRelay.close).toHaveBeenCalledTimes(2);
    expect(startRelay).toHaveBeenCalledOnce();
  });

  it("retains the adopted key when config refreshes during relay startup", async () => {
    const { profile, state } = createState();
    const replacement = createHandle(ROTATED_TOKEN);
    startRelay.mockImplementationOnce(async () => {
      refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
      return replacement;
    });

    await expect(ensureRelay(state, profile)).resolves.toBe(replacement);
    expect(state.resolved.extensionRelayToken).toBe(ROTATED_TOKEN);
    expect(state.extensionRelays?.get(PROFILE_NAME)).toBe(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("coalesces concurrent rebinds to one exact relay handle", async () => {
    const { oldRelay, profile, state, started, release, replacement } = pendingRebind();

    const first = ensureRelay(state, profile);
    await started.promise;
    const second = ensureRelay(state, profile);
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([replacement, replacement]);
    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(startRelay).toHaveBeenCalledOnce();
    expect(state.extensionRelays?.get(PROFILE_NAME)).toBe(replacement);
  });

  it.each(["initiator", "sibling"])(
    "keeps a shared rebind alive when its %s is cancelled",
    async (cancelled) => {
      const f = pendingRebind();
      const controller = new AbortController();
      const message = `${cancelled} browser request cancelled`;
      const first = f.lease(cancelled === "initiator" ? controller.signal : undefined);
      void first.catch(() => {});
      await f.started.promise;
      const second = f.lease(cancelled === "sibling" ? controller.signal : undefined);
      let cancellation: unknown;
      const rejected = cancelled === "initiator" ? first : second;
      void rejected.catch((error: unknown) => {
        cancellation = error;
      });
      void second.catch(() => {});
      await expect.poll(() => ensureToken.mock.calls.length).toBe(2);
      controller.abort(new Error(message));
      try {
        if (cancelled === "sibling") {
          await expect
            .poll(() => cancellation, { timeout: 200 })
            .toEqual(expect.objectContaining({ message }));
        }
      } finally {
        f.release.resolve();
      }
      await expect(rejected).rejects.toThrow(message);
      await expect(cancelled === "initiator" ? second : first).resolves.toBe(f.replacement);
      expect(f.oldRelay.close).toHaveBeenCalledOnce();
      expect(startRelay).toHaveBeenCalledOnce();
      expect(f.replacement.close).not.toHaveBeenCalled();
      expect(f.state.extensionRelays?.get(PROFILE_NAME)).toBe(f.replacement);
      expect(f.state.resolved.extensionRelayInternalTokens[PROFILE_NAME]).toBe(
        f.replacement.internalToken,
      );
      expect(getProfileLifecycle(f.runtime).leases.size).toBe(0);
    },
  );

  it("fences and drains a lifecycle-owned rebind when its profile transitions", async () => {
    const { oldRelay, state, runtime, started, release, replacement, lease } = pendingRebind();
    const pending = lease();
    void pending.catch(() => {});
    await started.promise;

    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "profile configuration changed",
      closeRelay: true,
    });
    await expect(pending).rejects.toThrow("profile configuration changed");
    release.resolve();
    await expect(transition).resolves.toMatchObject({ stopped: true });

    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(state.extensionRelays?.has(PROFILE_NAME)).toBe(false);
    expect(state.resolved.extensionRelayInternalTokens[PROFILE_NAME]).toBeUndefined();
    expect(getProfileLifecycle(runtime).leases.size).toBe(0);
  });
});
