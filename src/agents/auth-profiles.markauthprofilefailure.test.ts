import path from "node:path";
import { afterAll, assert, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import {
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStateRaw,
} from "./auth-profiles/sqlite.js";
import {
  ensureAuthProfileStore as loadStore,
  saveAuthProfileStore as saveStore,
} from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore, ProfileUsageStats } from "./auth-profiles/types.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure as markFailure,
  markAuthProfileBlockedUntil as blockUntil,
  markInlineProviderApiKeyFailure as markInlineFailure,
  resolveInlineProviderApiKeyUsageId as inlineUsageId,
} from "./auth-profiles/usage.js";

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));
// mock-isolation: Usage-state fixtures own the seeded profiles; ambient provider discovery must not add credentials.
vi.mock("../plugins/provider-external-auth-core.js", async () =>
  (await import("../plugins/provider-external-auth.test-support.js")).createExternalAuthMock(),
);

const tempDirs = createTempDirTracker();
afterAll(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

const profileId = "anthropic:default";
const apiKey = (provider: string, key: string) => ({ type: "api_key" as const, provider, key });
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
function fixture(usageStats?: AuthProfileStore["usageStats"]) {
  const agentDir = tempDirs.make("openclaw-auth-");
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      [profileId]: apiKey("anthropic", "sk-default"),
      "local:default": apiKey("local", "synthetic-key"),
    },
    usageStats,
  };
  saveStore(store, agentDir, saveOptions);
  return { store: loadStore(agentDir), agentDir };
}

it("does not overwrite fresher credentials with a stale runtime snapshot", async () => {
  const auth = fixture();
  saveStore(
    { ...auth.store, profiles: { [profileId]: apiKey("anthropic", "sk-fresh") } },
    auth.agentDir,
    saveOptions,
  );
  expect(auth.store.profiles[profileId]).toMatchObject({ key: "sk-default" });
  await markFailure({ ...auth, profileId, reason: "rate_limit", retryAfterMs: 60_000 });
  clearRuntimeAuthProfileStoreSnapshots();
  const reloaded = loadStore(auth.agentDir);
  expect(reloaded.profiles[profileId]).toMatchObject({ type: "api_key", key: "sk-fresh" });
  expect(reloaded.usageStats?.[profileId]?.cooldownUntil).toEqual(expect.any(Number));
});

it("records inline-key billing backoff without creating an auth profile", async () => {
  const auth = fixture();
  const startedAt = Date.now();
  await markInlineFailure({ ...auth, provider: "anthropic", reason: "billing" });
  const usageId = inlineUsageId("anthropic");
  const stats = auth.store.usageStats?.[usageId];
  expect(auth.store.profiles[usageId]).toBeUndefined();
  expect(stats?.disabledReason).toBe("billing");
  expect(loadStore(auth.agentDir).usageStats?.[usageId]?.disabledReason).toBe("billing");
  assert(stats?.lastFailureAt !== undefined);
  expect(stats.lastFailureAt).toBeGreaterThanOrEqual(startedAt);
  expect(stats.lastFailureAt).toBeLessThanOrEqual(Date.now());
  expect(stats.disabledUntil).toBe(stats.lastFailureAt + 10 * 60_000);
});

it("resets stale billing backoff and preserves its deadline on retry", async () => {
  const now = Date.now();
  const auth = fixture({
    [profileId]: {
      errorCount: 9,
      failureCounts: { billing: 3 },
      lastFailureAt: now - 48 * 60 * 60_000,
    },
  });
  const fail = () => markFailure({ ...auth, profileId, reason: "billing" });
  await fail();
  const first = auth.store.usageStats?.[profileId];
  expect(first).toMatchObject({ errorCount: 1, failureCounts: { billing: 1 } });
  assert(first?.lastFailureAt !== undefined);
  expect(first.lastFailureAt).toBeGreaterThanOrEqual(now);
  expect(first.lastFailureAt).toBeLessThanOrEqual(Date.now());
  const deadline = first.disabledUntil;
  expect(deadline).toBe(first.lastFailureAt + 600_000);
  await fail();
  expect(auth.store.usageStats?.[profileId]?.disabledUntil).toBe(deadline);
  expect(loadStore(auth.agentDir).usageStats?.[profileId]?.disabledUntil).toBe(deadline);
});

describe("provider-driven rate-limit cooldowns", () => {
  const model = "claude-test";
  const hour = 60 * 60_000;
  const reload = (agentDir: string) => {
    clearRuntimeAuthProfileStoreSnapshots();
    return loadStore(agentDir);
  };

  it("cools a rate-limited model down for exactly the provider's retry window", async () => {
    const auth = fixture();
    const before = Date.now();
    const retryAfterMs = 36 * hour;
    await markFailure({ ...auth, profileId, reason: "rate_limit", modelId: model, retryAfterMs });
    const after = Date.now();
    const stats = reload(auth.agentDir).usageStats?.[profileId];
    expect(stats).toMatchObject({ cooldownReason: "rate_limit", cooldownModel: model });
    expect(stats?.cooldownUntil).toBeGreaterThanOrEqual(before + retryAfterMs);
    expect(stats?.cooldownUntil).toBeLessThanOrEqual(after + retryAfterMs);
    expect(stats?.failureCounts).toBeUndefined();
    expect(stats?.errorCount).toBeUndefined();
  });

  it("leaves the profile usable when concurrent rate limits carry no provider timing", async () => {
    const auth = fixture();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        markFailure({ ...auth, profileId, reason: "rate_limit", modelId: model }),
      ),
    );
    const store = reload(auth.agentDir);
    expect(isProfileInCooldown(store, profileId, Date.now(), model)).toBe(false);
    expect(store.usageStats?.[profileId]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.[profileId]?.failureCounts).toBeUndefined();
    expect(store.usageStats?.[profileId]?.lastRateLimitAt).toEqual(expect.any(Number));
  });

  it("follows the latest provider deadline without escalating repeated failures", async () => {
    const auth = fixture();
    const fail = (retryAfterMs: number) =>
      markFailure({ ...auth, profileId, reason: "rate_limit", modelId: model, retryAfterMs });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await fail(60_000);
    }
    const repeated = reload(auth.agentDir).usageStats?.[profileId];
    expect(repeated?.cooldownUntil).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(repeated?.failureCounts).toBeUndefined();

    const before = Date.now();
    await fail(2 * hour);
    const extended = reload(auth.agentDir).usageStats?.[profileId]?.cooldownUntil;
    expect(extended).toBeGreaterThanOrEqual(before + 2 * hour);
    // A shorter answer for another concurrent request cannot reopen the window early.
    await fail(1_000);
    expect(reload(auth.agentDir).usageStats?.[profileId]?.cooldownUntil).toBe(extended);
  });

  it("releases a profile locked by the retired local rate-limit backoff on upgrade", async () => {
    const auth = fixture();
    const now = Date.now();
    const legacy = {
      cooldownUntil: now + 23 * hour,
      cooldownReason: "rate_limit",
      cooldownModel: model,
      errorCount: 14,
      failureCounts: { rate_limit: 14 },
      lastFailureAt: now - 60_000,
    };
    // Raw rows bypass the current writer, exactly as an older release left them.
    writePersistedAuthProfileStateRaw(
      { version: 1, usageStats: { [profileId]: legacy, "local:default": legacy } },
      auth.agentDir,
    );
    const upgraded = reload(auth.agentDir);
    expect(isProfileInCooldown(upgraded, profileId, now, model)).toBe(false);
    expect(upgraded.usageStats?.[profileId]).toEqual({
      lastFailureAt: now - 60_000,
      lastRateLimitAt: now - 60_000,
    });

    // The first provider-timed failure after upgrade is not held to the old window.
    await markFailure({
      ...auth,
      store: upgraded,
      profileId,
      reason: "rate_limit",
      modelId: model,
      retryAfterMs: 5_000,
    });
    const persisted = reload(auth.agentDir).usageStats;
    expect(persisted?.[profileId]?.cooldownUntil).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(persisted?.["local:default"]?.cooldownUntil).toBeUndefined();
  });
});

const managedSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "local-gateway", providers: ["local"], managesOwnAvailability: true }],
});
const withManagedProvider = (run: () => Promise<void>) =>
  withPluginMetadataSnapshotScope(managedSnapshot, run, { trustConfigIdentity: true });

it("does not persist direct overload failures for self-managed providers", async () => {
  const auth = fixture();
  await withManagedProvider(() =>
    markFailure({ ...auth, profileId: "local:default", reason: "overloaded" }),
  );
  expect(readPersistedAuthProfileStoreRaw(auth.agentDir)).toMatchObject({
    profiles: { "local:default": { provider: "local" } },
  });
  expect(readPersistedAuthProfileStateRaw(auth.agentDir)).toBeNull();
});

it("keeps subscription blocks and inline-key billing on self-managed providers", async () => {
  const auth = fixture();
  const until = Date.now() + 60_000;
  await withManagedProvider(async () => {
    await blockUntil({ ...auth, profileId: "local:default", blockedUntil: until, source: "wham" });
    await markInlineFailure({ ...auth, provider: "local", reason: "billing" });
  });
  const persisted = loadStore(auth.agentDir);
  expect(persisted.usageStats?.["local:default"]).toMatchObject({
    blockedUntil: until,
    blockedReason: "subscription_limit",
  });
  expect(persisted.usageStats?.[inlineUsageId("local")]?.disabledReason).toBe("billing");
});

describe("ClawRouter capacity ownership", () => {
  const clawRouterProfile = "clawrouter:default";
  const models = [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-fable-5-1",
    "openai/gpt-6.2-sol",
    "openai/gpt-6-astra",
  ];
  // The policy comes from the bundled manifest, not a fixture declaration.
  const withBundledClawRouter = (run: () => Promise<void>) =>
    withPluginMetadataSnapshotScope(
      createPluginMetadataSnapshotFixture(
        loadPluginManifestRegistryCore({
          installRecords: {},
          candidates: [
            {
              idHint: "clawrouter",
              rootDir: path.resolve("extensions", "clawrouter"),
              source: path.resolve("extensions", "clawrouter", "index.ts"),
              origin: "bundled" as const,
            },
          ],
        }),
      ),
      run,
      { trustConfigIdentity: true },
    );
  const clawRouterFixture = () => {
    const agentDir = tempDirs.make("openclaw-clawrouter-auth-");
    saveStore(
      { version: 1, profiles: { [clawRouterProfile]: apiKey("clawrouter", "synthetic-key") } },
      agentDir,
      saveOptions,
    );
    return agentDir;
  };
  const blockedModels = (store: AuthProfileStore) =>
    models.filter((model) => isProfileInCooldown(store, clawRouterProfile, Date.now(), model));

  it("keeps OpenAI models admitted after Opus and Fable hit ClawRouter's day-long retry floor", async () => {
    const agentDir = clawRouterFixture();
    await withBundledClawRouter(async () => {
      const store = loadStore(agentDir);
      // A second model's 429 inside the first window would widen a local
      // cooldown to the shared profile and refuse every OpenAI model.
      for (const modelId of models.slice(0, 2)) {
        await markFailure({
          store,
          agentDir,
          profileId: clawRouterProfile,
          reason: "rate_limit",
          modelId,
          retryAfterMs: 98_971_000,
        });
      }
      clearRuntimeAuthProfileStoreSnapshots();
      expect(blockedModels(loadStore(agentDir))).toEqual([]);
    });
    expect(readPersistedAuthProfileStateRaw(agentDir)).toBeNull();
  });

  // Raw rows bypass the current writer, exactly as an earlier release left them.
  const storedClawRouterFixture = (stats: ProfileUsageStats) => {
    const agentDir = clawRouterFixture();
    writePersistedAuthProfileStateRaw(
      { version: 1, usageStats: { [clawRouterProfile]: stats } },
      agentDir,
    );
    clearRuntimeAuthProfileStoreSnapshots();
    return agentDir;
  };
  const failRouterKey = async (agentDir: string) => {
    const failedAt = Date.now();
    await markFailure({
      store: loadStore(agentDir),
      agentDir,
      profileId: clawRouterProfile,
      reason: "auth",
    });
    clearRuntimeAuthProfileStoreSnapshots();
    return { failedAt, stats: loadStore(agentDir).usageStats?.[clawRouterProfile] };
  };

  it("releases a profile-wide ClawRouter rate-limit window stored before the upgrade", async () => {
    const agentDir = storedClawRouterFixture({
      cooldownUntil: Date.now() + 98_971_000,
      cooldownReason: "rate_limit",
      lastRateLimitAt: Date.now(),
    });
    await withBundledClawRouter(async () => {
      expect(blockedModels(loadStore(agentDir))).toEqual([]);
    });
  });

  // A timeout counted two failures before a capacity failure took over the shared window.
  it.each([
    { stored: "active rate-limit", reason: "rate_limit", untilOffsetMs: 98_971_000 },
    { stored: "active overload", reason: "overloaded", untilOffsetMs: 5 * 60_000 },
    { stored: "expired rate-limit", reason: "rate_limit", untilOffsetMs: -1_000 },
  ] as const)(
    "gives a router-key failure its own first window after a stored $stored window",
    async ({ reason, untilOffsetMs }) => {
      const now = Date.now();
      const agentDir = storedClawRouterFixture({
        cooldownUntil: now + untilOffsetMs,
        cooldownReason: reason,
        errorCount: 2,
        failureCounts: { timeout: 2 },
        lastFailureAt: now - 60_000,
      });
      await withBundledClawRouter(async () => {
        const { failedAt, stats } = await failRouterKey(agentDir);
        // Neither the stored deadline nor the stale count carries into the auth window.
        expect(stats).toMatchObject({
          cooldownReason: "auth",
          errorCount: 1,
          failureCounts: { auth: 1 },
        });
        expect(stats?.cooldownUntil).toBeLessThanOrEqual(Date.now() + 30_000);
        expect(stats?.cooldownUntil).toBeGreaterThanOrEqual(failedAt + 30_000);
      });
    },
  );
});
