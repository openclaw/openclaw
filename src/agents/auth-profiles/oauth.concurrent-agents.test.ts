import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } = await import("./oauth.js"));
}

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai-codex" }],
}));

describe("resolveApiKeyForProfile cross-agent refresh coordination (#26322)", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let mainAgentDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-concurrent-");
    mainAgentDir = await createOAuthMainAgentDir(tempRoot);
    await loadOAuthModuleForTest();
    // Drop any refresh-queue entries left behind by a prior timed-out test.
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    if (resetOAuthRefreshQueuesForTest) {
      resetOAuthRefreshQueuesForTest();
    }
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("refreshes exactly once when many agents share one OAuth profile and all race on expiry", async () => {
    const agentCount = 4;
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    // Seed sub-agents + main with the SAME stale OAuth credential. Main is
    // also expired so it cannot short-circuit via adoptNewerMainOAuthCredential.
    const subAgents = await Promise.all(
      Array.from({ length: agentCount }, async (_, i) => {
        const dir = path.join(tempRoot, "agents", `sub-${i}`, "agent");
        await fs.mkdir(dir, { recursive: true });
        saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), dir);
        return dir;
      }),
    );
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    // Count invocations, and keep one event-loop turn to widen the race window.
    let callCount = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      callCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return {
        type: "oauth",
        provider,
        access: "cross-agent-refreshed-access",
        refresh: "cross-agent-refreshed-refresh",
        expires: freshExpiry,
        accountId,
      } as never;
    });

    // Fire all agents concurrently. With the old per-agentDir lock this
    // would produce one refresh call per agent and refresh_token_reused
    // 401s. With the new global per-profile lock, only the first refresh is
    // performed; the remaining agents adopt the resulting fresh credentials.
    const results = await Promise.all(
      subAgents.map((agentDir) =>
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(agentDir),
          profileId,
          agentDir,
        }),
      ),
    );

    expect(callCount).toBe(1);
    expect(results).toHaveLength(agentCount);
    for (const result of results) {
      expect(result).not.toBeNull();
      expect(result?.apiKey).toBe("cross-agent-refreshed-access");
      expect(result?.provider).toBe(provider);
    }
  }, 10_000);

  // Regression for #74055. The cross-agent refresh lock prevents two peers
  // from spending the same refresh_token *concurrently*, but the recovery
  // path that lets a queued peer skip its own refresh depends entirely on
  // the leader's mirror-to-main write actually landing on disk. When that
  // mirror is dropped — which happens in the field on Windows when the
  // main auth-profiles.json is briefly held by a security agent, when the
  // mirror's withFileLock times out, or when an external process rolls the
  // file back — the leader's refresh succeeds but the disk under main is
  // stale. The next peer then hits the inside-lock adoption check, finds
  // main "still expired", falls through to refresh, and burns its own (now
  // already-rotated) refresh_token, surfacing 401 refresh_token_reused.
  //
  // We reproduce that failure mode below by letting the leader refresh and
  // mirror normally, then forcibly reverting main on disk to the pre-mirror
  // state and stalling any subsequent refresh with refresh_token_reused.
  // A correct fix must let the second peer recover from the leader's
  // result without touching main on disk.
  it("rescues a queued peer when the leader's mirror to main is lost (issue #74055)", async () => {
    const profileId = "openai-codex:user@example.com";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const email = "user@example.com";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    const mainAuthFile = path.join(mainAgentDir, "auth-profiles.json");

    const leaderAgentDir = path.join(tempRoot, "agents", "leader", "agent");
    const followerAgentDir = path.join(tempRoot, "agents", "follower", "agent");
    await fs.mkdir(leaderAgentDir, { recursive: true });
    await fs.mkdir(followerAgentDir, { recursive: true });
    const seedExpiredStore = (): AuthProfileStore =>
      createExpiredOauthStore({ profileId, provider, accountId, email });
    saveAuthProfileStore(seedExpiredStore(), leaderAgentDir);
    saveAuthProfileStore(seedExpiredStore(), followerAgentDir);
    saveAuthProfileStore(seedExpiredStore(), mainAgentDir);

    // The leader's refresh succeeds with the post-rotation token. Every
    // subsequent attempt fails the way the OpenAI provider actually fails
    // when a peer presents an already-rotated refresh_token, which is the
    // exact 401 the user reported in #74055.
    let callCount = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      callCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      if (callCount > 1) {
        throw new Error('Token refresh failed: 401 {"error":{"code":"refresh_token_reused"}}');
      }
      return {
        type: "oauth",
        provider,
        access: "leader-rotated-access",
        refresh: "leader-rotated-refresh",
        expires: freshExpiry,
        accountId,
        email,
      } as never;
    });

    const leaderResult = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(leaderAgentDir),
      profileId,
      agentDir: leaderAgentDir,
    });
    expect(leaderResult?.apiKey).toBe("leader-rotated-access");
    expect(callCount).toBe(1);

    // The leader's refresh briefly mirrored to main; we now simulate the
    // mirror being lost — antivirus reverting the file, an external
    // process rewriting it, an EBUSY swallowed by the silent catch in
    // mirrorRefreshedCredentialIntoMainStore, etc. The follower must not
    // assume disk-side main is the only source of truth.
    saveAuthProfileStore(seedExpiredStore(), mainAgentDir);
    const mainAfterRollback = JSON.parse(
      await fs.readFile(mainAuthFile, "utf8"),
    ) as AuthProfileStore;
    expect(mainAfterRollback.profiles[profileId]).toMatchObject({
      access: "cached-access-token",
      refresh: "refresh-token",
    });

    // The follower must rescue itself from the leader's still-fresh
    // in-process refresh result rather than spending its own already-
    // rotated refresh_token on the provider.
    const followerResult = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(followerAgentDir),
      profileId,
      agentDir: followerAgentDir,
    });

    // No second refresh: follower must adopt the leader's already-rotated
    // credential without going to the provider with its own stale token.
    expect(callCount).toBe(1);
    expect(followerResult).not.toBeNull();
    expect(followerResult?.apiKey).toBe("leader-rotated-access");
    expect(followerResult?.provider).toBe(provider);

    // Follower's own store on disk now carries the rescued credential so
    // the next request short-circuits before re-entering the queue.
    const followerOnDisk = JSON.parse(
      await fs.readFile(path.join(followerAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(followerOnDisk.profiles[profileId]).toMatchObject({
      access: "leader-rotated-access",
      refresh: "leader-rotated-refresh",
      expires: freshExpiry,
    });
  }, 10_000);

  // Greptile review feedback on #74214: align the in-process cache adoption
  // path with the disk-side adoption path's freshness guard. A still-valid
  // local credential must not be silently rewritten on every resolve just
  // because a peer's rotation result sits in the cache; only adopt when the
  // cached credential is strictly newer than the agent's local view.
  it("leaves a still-valid local credential alone when the cached peer credential is not strictly newer", async () => {
    const profileId = "openai-codex:user@example.com";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const email = "user@example.com";
    const localExpiry = Date.now() + 30 * 60 * 1000;
    const peerExpiry = localExpiry; // same expiry — not strictly newer

    const leaderAgentDir = path.join(tempRoot, "agents", "freshness-leader", "agent");
    const followerAgentDir = path.join(tempRoot, "agents", "freshness-follower", "agent");
    await fs.mkdir(leaderAgentDir, { recursive: true });
    await fs.mkdir(followerAgentDir, { recursive: true });

    // Both leader and follower already hold valid credentials. Only the
    // leader actually goes through a refresh (because we expire it first
    // to force one); the follower's local credential is healthy and must
    // not be replaced.
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId, email }),
      leaderAgentDir,
    );
    const followerLocal = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth" as const,
          provider,
          access: "follower-still-valid-access",
          refresh: "follower-still-valid-refresh",
          expires: localExpiry,
          accountId,
          email,
        },
      },
    } satisfies AuthProfileStore;
    saveAuthProfileStore(followerLocal, followerAgentDir);
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId, email }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "leader-rotated-access",
          refresh: "leader-rotated-refresh",
          expires: peerExpiry,
          accountId,
          email,
        }) as never,
    );

    // Leader populates the in-process refresh cache.
    await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(leaderAgentDir),
      profileId,
      agentDir: leaderAgentDir,
    });

    // Follower resolves with a still-valid credential. The cached peer
    // credential is not strictly newer (same expiry), so the follower must
    // keep its own credential and must not write to its store.
    const followerResult = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(followerAgentDir),
      profileId,
      agentDir: followerAgentDir,
    });
    expect(followerResult?.apiKey).toBe("follower-still-valid-access");

    const followerOnDisk = JSON.parse(
      await fs.readFile(path.join(followerAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(followerOnDisk.profiles[profileId]).toMatchObject({
      access: "follower-still-valid-access",
      refresh: "follower-still-valid-refresh",
      expires: localExpiry,
    });
  }, 10_000);

  // Branch coverage for the freshness guard's left disjunct: when the local
  // credential lacks a finite expiry (legacy stores written before expiry
  // tracking, or a malformed copy), the cache must still be consulted so a
  // peer's rotated token can take over rather than the agent forever
  // believing it has a "valid" credential.
  it("adopts a peer-rotated credential when the local credential has no finite expiry", async () => {
    const profileId = "openai-codex:user@example.com";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const email = "user@example.com";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const leaderAgentDir = path.join(tempRoot, "agents", "infexp-leader", "agent");
    const followerAgentDir = path.join(tempRoot, "agents", "infexp-follower", "agent");
    await fs.mkdir(leaderAgentDir, { recursive: true });
    await fs.mkdir(followerAgentDir, { recursive: true });

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId, email }),
      leaderAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId, email }),
      mainAgentDir,
    );
    // Follower has a credential with no finite expiry — exercises the
    // `!Number.isFinite(params.credential.expires)` branch of the cache
    // freshness guard in `adoptNewerMainOAuthCredential`.
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth" as const,
            provider,
            access: "follower-no-expiry-access",
            refresh: "follower-no-expiry-refresh",
            expires: Number.POSITIVE_INFINITY,
            accountId,
            email,
          },
        },
      } satisfies AuthProfileStore,
      followerAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "leader-rotated-access",
          refresh: "leader-rotated-refresh",
          expires: freshExpiry,
          accountId,
          email,
        }) as never,
    );

    await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(leaderAgentDir),
      profileId,
      agentDir: leaderAgentDir,
    });

    const followerResult = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(followerAgentDir),
      profileId,
      agentDir: followerAgentDir,
    });

    // Follower must adopt the cached peer credential even though its own
    // local view appears "non-expired" (Infinity > everything).
    expect(followerResult?.apiKey).toBe("leader-rotated-access");
    const followerOnDisk = JSON.parse(
      await fs.readFile(path.join(followerAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(followerOnDisk.profiles[profileId]).toMatchObject({
      access: "leader-rotated-access",
      refresh: "leader-rotated-refresh",
      expires: freshExpiry,
    });
  }, 10_000);

  // Reviewer IMPORTANT on #74214: the in-process cache has no LRU/TTL, and
  // `rememberRefreshedCredential` now sweeps expired siblings on every
  // publish. The Map is closure-private, so this test exercises the
  // externally-observable invariant that the sweep is meant to preserve:
  // an already-expired cached entry for one (provider, profileId) must NOT
  // hijack a subsequent rotation for the same profile from a different
  // agent, even after a fresh publish for an unrelated profile has run.
  // The freshness gate inside `findInProcessRefreshedCredential` plus the
  // new sweep together pin this behavior; a regression in either layer
  // would surface as a stale-token reuse here.
  it("evicts expired sibling cache entries when a new refresh result is published", async () => {
    const provider = "openai-codex";
    const accountIdA = "acct-A";
    const accountIdB = "acct-B";
    const emailA = "userA@example.com";
    const emailB = "userB@example.com";
    const profileIdA = "openai-codex:userA@example.com";
    const profileIdB = "openai-codex:userB@example.com";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const agentA = path.join(tempRoot, "agents", "evict-A", "agent");
    const agentB = path.join(tempRoot, "agents", "evict-B", "agent");
    await fs.mkdir(agentA, { recursive: true });
    await fs.mkdir(agentB, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId: profileIdA,
        provider,
        accountId: accountIdA,
        email: emailA,
      }),
      agentA,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId: profileIdB,
        provider,
        accountId: accountIdB,
        email: emailB,
      }),
      agentB,
    );

    // Profile A's leader rotates first. The mock returns a credential
    // that is ALREADY EXPIRED — this lets us verify the entry exists in
    // the cache (it is the most recent successful refresh result) but
    // becomes ineligible for adoption immediately, so a later publish
    // for profile B must sweep it.
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "A-rotated-but-expired-access",
          refresh: "A-rotated-but-expired-refresh",
          // Just-past expiry — usable check returns false going forward.
          expires: Date.now() - 1,
          accountId: accountIdA,
          email: emailA,
        }) as never,
    );
    await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(agentA),
      profileId: profileIdA,
      agentDir: agentA,
    });

    // Profile B's leader rotates next. The new publish must sweep A's
    // now-expired sibling entry while inserting B's fresh entry.
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "B-rotated-fresh-access",
          refresh: "B-rotated-fresh-refresh",
          expires: freshExpiry,
          accountId: accountIdB,
          email: emailB,
        }) as never,
    );
    const bResult = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(agentB),
      profileId: profileIdB,
      agentDir: agentB,
    });
    expect(bResult?.apiKey).toBe("B-rotated-fresh-access");

    // Now another agent for profile A asks to resolve. Because the cache
    // entry for A was swept (or, equivalently, is no longer usable), it
    // must NOT be returned: a fresh refresh must run instead. We assert
    // by setting up the mock to fail if called — if the cache somehow
    // held A's stale entry without the freshness gate catching it, this
    // would surface; if it correctly refreshes, the mock's third call
    // produces a fresh credential.
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "A-second-rotated-access",
          refresh: "A-second-rotated-refresh",
          expires: freshExpiry,
          accountId: accountIdA,
          email: emailA,
        }) as never,
    );
    const aSecondAgent = path.join(tempRoot, "agents", "evict-A2", "agent");
    await fs.mkdir(aSecondAgent, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId: profileIdA,
        provider,
        accountId: accountIdA,
        email: emailA,
      }),
      aSecondAgent,
    );
    const aResult = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(aSecondAgent),
      profileId: profileIdA,
      agentDir: aSecondAgent,
    });
    // Second A agent gets a brand-new rotation, not the stale cache entry.
    expect(aResult?.apiKey).toBe("A-second-rotated-access");
  }, 10_000);
});
