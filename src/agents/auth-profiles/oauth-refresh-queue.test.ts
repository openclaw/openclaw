/** Tests durable ownership after an OAuth refresh failure. */
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv } from "../../test-utils/env.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import "./oauth-file-lock-passthrough.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { resetOAuthRefreshQueuesForTest } from "./oauth.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

describe("OAuth refresh failure ownership", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let agentDir = "";
  let caseIndex = 0;

  beforeAll(async () => {
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-queue-");
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    clearRuntimeAuthProfileStoreSnapshots();
    const caseRoot = path.join(tempRoot, `case-${++caseIndex}`);
    agentDir = await createOAuthMainAgentDir(caseRoot);
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("fences the failed generation instead of retrying it", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), agentDir);

    let callCount = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
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

    const [first, second] = await Promise.all([
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e: unknown) => e),
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e: unknown) => e),
    ]);

    expect(first).toBeInstanceOf(Error);
    expect(callCount).toBe(1);
    expect(second).toBeNull();
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
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir);
    const started = createDeferredCore();
    const release = createDeferredCore<OAuthCredential>();
    const settled = createDeferredCore();
    const refreshCredential = vi.fn(async () => {
      started.resolve();
      return await release.promise;
    });
    const manager = createOAuthManager({
      buildApiKey: async (_provider, value) => {
        settled.resolve();
        return value.access;
      },
      canRefreshCredential: async () => true,
      refreshCredential,
      readBootstrapCredential: () => null,
    });
    const params = {
      store: ensureAuthProfileStore(agentDir),
      profileId,
      credential,
      agentDir,
    };
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const activeReason = new Error("active lookup cancelled");
    const queuedReason = new Error("queued lookup cancelled");
    const active = manager.resolveOAuthAccess({ ...params, signal: activeController.signal });
    const activeRejected = expect(active).rejects.toBe(activeReason);
    await started.promise;
    const queued = manager.resolveOAuthAccess({ ...params, signal: queuedController.signal });
    const queuedRejected = expect(queued).rejects.toBe(queuedReason);
    const requests: Promise<unknown>[] = [active, queued];
    try {
      queuedController.abort(queuedReason);
      await queuedRejected;
      activeController.abort(activeReason);
      await activeRejected;
      const pending = ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
      expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
      release.resolve(refreshed);
      await settled.promise;
      const continuing = manager.resolveOAuthAccess(params);
      requests.push(continuing);
      await expect(continuing).resolves.toMatchObject({ apiKey: "rotated-access" });
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
      ).toMatchObject(refreshed);
      expect(refreshCredential).toHaveBeenCalledOnce();
    } finally {
      activeController.abort(activeReason);
      queuedController.abort(queuedReason);
      release.resolve(refreshed);
      await settled.promise;
      await Promise.allSettled(requests);
    }
  });

  it("serializes a 10-caller burst", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), agentDir);

    const startOrder: number[] = [];
    const endOrder: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let seq = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      const n = ++seq;
      startOrder.push(n);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      endOrder.push(n);
      return {
        type: "oauth",
        provider,
        access: `refreshed-${n}`,
        refresh: `refresh-${n}`,
        expires: Date.now() - 1_000,
      } as never;
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(agentDir),
          profileId,
          agentDir,
        }).catch((e: unknown) => e),
      ),
    );

    expect(results).toHaveLength(10);
    expect(startOrder).toEqual(endOrder);
    expect(maxInFlight).toBe(1);
  });
});
