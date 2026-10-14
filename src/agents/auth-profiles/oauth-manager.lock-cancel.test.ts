import { afterEach, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { drainFileLockStateForTest } from "../../infra/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOAuthManager } from "./oauth-manager.js";
import * as profileLocks from "./oauth-profile-lock.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

// Unlike the queue fixture, this test keeps the real file-lock owner.
afterEach(() => vi.restoreAllMocks());

it("cancels credential observation while the profile lock remains held", async () => {
  await withOpenClawTestState(
    { label: "oauth-preclaim-cancel", agentEnv: "main" },
    async (state) => {
      const profileId = "synthetic:locked";
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "synthetic",
        access: "synthetic-expired-access",
        refresh: "synthetic-expired-refresh",
        expires: Date.now() - 60_000,
      };
      const refreshed = {
        ...credential,
        access: "synthetic-rotated-access",
        refresh: "synthetic-rotated-refresh",
        expires: Date.now() + 60_000,
      };
      await state.writeAuthProfiles({ version: 1, profiles: { [profileId]: credential } });
      const agentDir = state.agentDir();
      const refreshCredential = vi.fn(async () => refreshed);
      const manager = createOAuthManager({
        buildApiKey: async (_provider, value) => value.access,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => null,
      });
      const held = createDeferredCore();
      const release = createDeferredCore();
      const entering = createDeferredCore();
      const withLock = profileLocks.withOAuthProfileLock;
      const holder = withLock({ provider: credential.provider, profileId }, async () => {
        held.resolve();
        await release.promise;
      });
      const work: Promise<unknown>[] = [holder];
      const controller = new AbortController();
      const reason = new Error("credential caller cancelled before claim");
      try {
        await Promise.race([held.promise, holder]);
        vi.spyOn(profileLocks, "withOAuthProfileLock").mockImplementation(
          async (key, operation, options) => {
            entering.resolve();
            return await withLock(key, operation, options);
          },
        );
        const params = {
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential,
          agentDir,
        };
        const lookup = manager.resolveOAuthAccess({ ...params, signal: controller.signal });
        work.push(lookup);
        const cancelled = expect(lookup).rejects.toBe(reason);
        await entering.promise;
        controller.abort(reason);
        await withTestTimeout(cancelled, 1_000, "caller remained blocked on the held OAuth lock");
        expect(refreshCredential).not.toHaveBeenCalled();

        release.resolve();
        await holder;
        await drainFileLockStateForTest();
        expect(refreshCredential).not.toHaveBeenCalled();
        expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toEqual(
          credential,
        );
        await expect(manager.resolveOAuthAccess(params)).resolves.toMatchObject({
          apiKey: "synthetic-rotated-access",
        });
        expect(refreshCredential).toHaveBeenCalledOnce();
      } finally {
        controller.abort(reason);
        release.resolve();
        await Promise.allSettled(work);
        await drainFileLockStateForTest();
      }
    },
  );
});
