import { beforeEach, describe, expect, it, vi } from "vitest";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { refreshResolvedBrowserConfigFromDisk } from "../resolved-config-refresh.js";
import {
  beginProfileTransition,
  getOrCreateProfileRuntime,
  getProfileLifecycle,
  withProfileOperationLease,
} from "../server-context.lifecycle.js";
import type { BrowserServerState } from "../server-context.types.js";
import type { ExtensionRelayHandle } from "./relay-server.js";

const ensureExtensionRelayTokenMock = vi.fn();
vi.mock("./relay-auth.js", () => ({
  ensureExtensionRelayToken: () => ensureExtensionRelayTokenMock(),
}));

vi.mock("../config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => ({
    browser: { profiles: { chrome: { driver: "extension", cdpPort: RELAY_PORT } } },
  }),
}));

const startExtensionRelayServerMock = vi.fn();
vi.mock("./relay-server.js", () => ({
  startExtensionRelayServer: (...args: unknown[]) => startExtensionRelayServerMock(...args),
}));

import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";

const OLD_TOKEN = relayTestKey(1);
const ROTATED_TOKEN = relayTestKey(2);

const PROFILE_NAME = "chrome";
const RELAY_PORT = 18_123;

function createState(token: string, existing?: ExtensionRelayHandle) {
  const resolved = {
    ...resolveBrowserConfig({
      profiles: { [PROFILE_NAME]: { driver: "extension", cdpPort: RELAY_PORT } },
      extensionRelay: { allowLegacyAuth: true },
    }),
    extensionRelayToken: token,
    extensionRelayInternalTokens: existing ? { [PROFILE_NAME]: existing.internalToken } : {},
  };
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
  const { profile, state } = createState(OLD_TOKEN, oldRelay);
  const runtime = getOrCreateProfileRuntime(state, profile);
  const startEntered = Promise.withResolvers<void>();
  const releaseStart = Promise.withResolvers<void>();
  const replacement = createHandle(ROTATED_TOKEN);
  startExtensionRelayServerMock.mockImplementationOnce(async () => {
    startEntered.resolve();
    await releaseStart.promise;
    return replacement;
  });
  const ensure = (signal?: AbortSignal) =>
    withProfileOperationLease({
      state,
      runtime,
      signal,
      run: (leaseSignal) => ensureExtensionRelayForProfile(state, profile, leaseSignal),
    });
  return { oldRelay, state, runtime, ensure, startEntered, releaseStart, replacement };
}

function expectRebound(f: ReturnType<typeof pendingRebind>) {
  expect(f.oldRelay.close).toHaveBeenCalledOnce();
  expect(startExtensionRelayServerMock).toHaveBeenCalledOnce();
  expect(f.replacement.close).not.toHaveBeenCalled();
  expect(getProfileLifecycle(f.runtime).leases.size).toBe(0);
  expect(f.state.extensionRelays?.get(PROFILE_NAME)).toBe(f.replacement);
  expect(f.state.resolved.extensionRelayInternalTokens[PROFILE_NAME]).toBe(
    f.replacement.internalToken,
  );
}

describe("extension relay lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureExtensionRelayTokenMock.mockResolvedValue(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementation(async ({ port, token, allowLegacyAuth }) => ({
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
    const { profile, state } = createState(OLD_TOKEN, oldRelay);

    await expect(ensureExtensionRelayForProfile(state, profile)).rejects.toThrow(
      "relay still listening",
    );

    const runtime = state.profiles.get(profile.name);
    expect(runtime && getProfileLifecycle(runtime).blockedReason).toBeNull();
    expect(startExtensionRelayServerMock).not.toHaveBeenCalled();
    expect(state.extensionRelays?.get(profile.name)).toBe(oldRelay);

    await expect(ensureExtensionRelayForProfile(state, profile)).resolves.toEqual(
      expect.objectContaining({ token: ROTATED_TOKEN }),
    );
    expect(oldRelay.close).toHaveBeenCalledTimes(2);
    expect(startExtensionRelayServerMock).toHaveBeenCalledOnce();
  });

  it("retains the adopted key when config refreshes during relay startup", async () => {
    const { profile, state } = createState(OLD_TOKEN);
    const replacement = createHandle(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementationOnce(async () => {
      refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
      return replacement;
    });

    await expect(ensureExtensionRelayForProfile(state, profile)).resolves.toBe(replacement);
    expect(state.resolved.extensionRelayToken).toBe(ROTATED_TOKEN);
    expect(state.extensionRelays?.get(PROFILE_NAME)).toBe(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it.each(["first", "sibling"])(
    "keeps a shared rebind alive after cancelling its %s caller",
    async (cancelled) => {
      const f = pendingRebind();
      const controller = new AbortController();
      const first = f.ensure(cancelled === "first" ? controller.signal : undefined);
      void first.catch(() => {});
      await f.startEntered.promise;
      const sibling = f.ensure(cancelled === "sibling" ? controller.signal : undefined);
      const rejected = cancelled === "first" ? first : sibling;
      const survivor = cancelled === "first" ? sibling : first;
      void survivor.catch(() => {});
      let rejection: unknown;
      void rejected.catch((error: unknown) => {
        rejection = error;
      });
      await expect.poll(() => ensureExtensionRelayTokenMock.mock.calls.length).toBe(2);
      const message = `${cancelled} browser request cancelled`;
      controller.abort(new Error(message));
      try {
        await expect
          .poll(() => rejection, { timeout: 200 })
          .toEqual(expect.objectContaining({ message }));
      } finally {
        f.releaseStart.resolve();
      }
      await expect(rejected).rejects.toThrow(message);
      await expect(survivor).resolves.toBe(f.replacement);
      expectRebound(f);
    },
  );

  it("fences and drains a lifecycle-owned rebind when its profile transitions", async () => {
    const f = pendingRebind();
    const pending = f.ensure();
    void pending.catch(() => {});
    await f.startEntered.promise;

    const transition = beginProfileTransition({
      state: f.state,
      runtime: f.runtime,
      reason: "profile configuration changed",
      closeRelay: true,
    });
    await expect(pending).rejects.toThrow("profile configuration changed");
    f.releaseStart.resolve();
    await expect(transition).resolves.toEqual(expect.objectContaining({ stopped: true }));

    expect(f.oldRelay.close).toHaveBeenCalledOnce();
    expect(f.replacement.close).toHaveBeenCalledOnce();
    expect(f.state.extensionRelays?.has(PROFILE_NAME)).toBe(false);
    expect(f.state.resolved.extensionRelayInternalTokens[PROFILE_NAME]).toBeUndefined();
    expect(getProfileLifecycle(f.runtime).leases.size).toBe(0);
  });
});
