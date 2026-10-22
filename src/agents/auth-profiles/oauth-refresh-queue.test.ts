/** Tests durable ownership after an OAuth refresh failure. */
import { describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { useOAuthCoordinationFixture } from "./oauth-coordination.test-support.js";
import "./oauth-file-lock-passthrough.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { mockOAuthProviderOperations } from "./oauth-native-provider.test-support.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { createExpiredOauthStore } from "./oauth-test-utils.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

const fx = useOAuthCoordinationFixture();

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

describe("OAuth refresh failure ownership", () => {
  it("fences the failed generation instead of retrying it", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), fx.mainDir);

    let callCount = 0;
    fx.refresh.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("simulated upstream failure");
      }
      // A failed owner leaves its generation fenced. No peer may replay it.
      return {
        type: "oauth",
        provider,
        access: "second-try-access",
        refresh: "second-try-refresh",
        expires: Date.now() + 60_000,
      } as never;
    });

    const results = await Promise.all([
      fx.resolve(fx.mainDir).catch((e: unknown) => e),
      fx.resolve(fx.mainDir).catch((e: unknown) => e),
    ]);

    expect(results.filter((result) => result instanceof Error)).toHaveLength(1);
    expect(callCount).toBe(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it("cancels auth waiters while the canonical refresh owner durably settles for another caller", async () => {
    const profileId = "xai:default";
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "xai",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() - 60_000,
      accountId: "synthetic-account",
    };
    const refreshed = {
      ...credential,
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 600_000,
    };
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, fx.mainDir);
    const started = createDeferredCore();
    const release = createDeferredCore<OAuthCredential>();
    const settled = createDeferredCore();
    const refreshCredential = vi.fn(async () => {
      started.resolve();
      return await release.promise;
    });
    mockOAuthProviderOperations({
      buildApiKey: async (_provider, value) => {
        settled.resolve();
        return value.access;
      },
      refreshCredential,
    });
    const manager = createOAuthManager();
    const params = {
      store: ensureAuthProfileStore(fx.mainDir),
      profileId,
      credential,
      agentDir: fx.mainDir,
    };
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const activeReason = new Error("active lookup cancelled");
    const queuedReason = new Error("queued lookup cancelled");
    const scope = new AsyncWorkScope();
    const active = scope.run(() =>
      manager.resolveOAuthAccess({ ...params, signal: activeController.signal }),
    );
    const activeRejected = expect(active).rejects.toBe(activeReason);
    const requests: Promise<unknown>[] = [active, activeRejected];
    const cleanup = async () => {
      activeController.abort(activeReason);
      queuedController.abort(queuedReason);
      release.resolve(refreshed);
      await Promise.allSettled([...requests, scope.drain()]);
    };
    fx.settle(async () => {
      await cleanup();
      vi.restoreAllMocks();
    });
    try {
      await started.promise;
      const queued = scope.run(() =>
        manager.resolveOAuthAccess({ ...params, signal: queuedController.signal }),
      );
      const queuedRejected = expect(queued).rejects.toBe(queuedReason);
      requests.push(queued, queuedRejected);
      queuedController.abort(queuedReason);
      await queuedRejected;
      activeController.abort(activeReason);
      await activeRejected;
      const pending = ensureAuthProfileStoreWithoutExternalProfiles(fx.mainDir).profiles[profileId];
      expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
      let drained = false;
      const draining = scope.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.resolve(refreshed);
      await draining;
      await settled.promise;
      const continuing = manager.resolveOAuthAccess(params);
      requests.push(continuing);
      await expect(continuing).resolves.toMatchObject({ apiKey: "rotated-access" });
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(fx.mainDir).profiles[profileId],
      ).toMatchObject(refreshed);
      expect(refreshCredential).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });
});
