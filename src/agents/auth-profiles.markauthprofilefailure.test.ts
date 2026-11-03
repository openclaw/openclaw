import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import {
  writePersistedAuthProfileStateRaw,
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileBlockedUntil,
  markInlineProviderApiKeyFailure,
  resolveInlineProviderApiKeyUsageId,
} from "./auth-profiles/usage.js";

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));
vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({ resolveExternalAuthProfilesWithPlugins: () => [] }),
}));

let tempRoot = "";
let caseIndex = 0;
beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
});
afterAll(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function fixture(usageStats?: AuthProfileStore["usageStats"]) {
  const agentDir = path.join(tempRoot, String(++caseIndex));
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-default" },
      "local:default": { type: "api_key", provider: "local", key: "synthetic-key" },
    },
    usageStats,
  };
  saveAuthProfileStore(store, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
  return { store: ensureAuthProfileStore(agentDir), agentDir };
}
const profileId = "anthropic:default";

describe("markAuthProfileFailure", () => {
  it("does not overwrite fresher credentials with a stale runtime snapshot", async () => {
    const { store, agentDir } = fixture();
    saveAuthProfileStore(
      {
        ...store,
        profiles: { [profileId]: { type: "api_key", provider: "anthropic", key: "sk-fresh" } },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    expect(store.profiles[profileId]).toMatchObject({ key: "sk-default" });
    await markAuthProfileFailure({
      store,
      agentDir,
      profileId,
      reason: "rate_limit",
      retryAfterMs: 60_000,
    });
    clearRuntimeAuthProfileStoreSnapshots();
    const reloaded = ensureAuthProfileStore(agentDir);
    expect(reloaded.profiles[profileId]).toMatchObject({ type: "api_key", key: "sk-fresh" });
    expect(reloaded.usageStats?.[profileId]?.cooldownUntil).toEqual(expect.any(Number));
  });

  it("records inline-key billing backoff without creating an auth profile", async () => {
    const { store, agentDir } = fixture();
    const startedAt = Date.now();
    await markInlineProviderApiKeyFailure({
      store,
      agentDir,
      provider: "anthropic",
      reason: "billing",
    });
    const usageId = resolveInlineProviderApiKeyUsageId("anthropic");
    const stats = store.usageStats?.[usageId];
    expect(store.profiles[usageId]).toBeUndefined();
    expect(stats?.disabledReason).toBe("billing");
    expect(ensureAuthProfileStore(agentDir).usageStats?.[usageId]?.disabledReason).toBe("billing");
    assert(stats?.lastFailureAt !== undefined);
    expect(stats.lastFailureAt).toBeGreaterThanOrEqual(startedAt);
    expect(stats.lastFailureAt).toBeLessThanOrEqual(Date.now());
    expect(stats.disabledUntil).toBe(stats.lastFailureAt + 10 * 60_000);
  });

  it("resets old billing failures, then preserves the new deadline across retries", async () => {
    const now = Date.now();
    const { store, agentDir } = fixture({
      [profileId]: {
        errorCount: 9,
        failureCounts: { billing: 3 },
        lastFailureAt: now - 48 * 60 * 60_000,
      },
    });
    const fail = () => markAuthProfileFailure({ store, agentDir, profileId, reason: "billing" });
    await fail();
    const first = store.usageStats?.[profileId];
    expect(first?.errorCount).toBe(1);
    expect(first?.failureCounts?.billing).toBe(1);
    assert(first?.lastFailureAt !== undefined);
    expect(first.lastFailureAt).toBeGreaterThanOrEqual(now);
    expect(first.lastFailureAt).toBeLessThanOrEqual(Date.now());
    expect(first.disabledUntil).toBe(first.lastFailureAt + 10 * 60_000);
    const deadline = first?.disabledUntil;
    await fail();
    expect(store.usageStats?.[profileId]?.disabledUntil).toBe(deadline);
    expect(ensureAuthProfileStore(agentDir).usageStats?.[profileId]?.disabledUntil).toBe(deadline);
  });

  const managedSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "local-gateway", providers: ["local"], managesOwnAvailability: true }],
  });
  it("does not persist direct overload failures for self-managed providers", async () => {
    const { store, agentDir } = fixture();
    await withPluginMetadataSnapshotScope(
      managedSnapshot,
      () =>
        markAuthProfileFailure({
          store,
          agentDir,
          profileId: "local:default",
          reason: "overloaded",
        }),
      { trustConfigIdentity: true },
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toMatchObject({
      profiles: { "local:default": { provider: "local" } },
    });
    expect(readPersistedAuthProfileStateRaw(agentDir)).toBeNull();
  });

  it("keeps subscription blocks and inline-key billing on self-managed providers", async () => {
    const { store, agentDir } = fixture();
    const until = Date.now() + 60_000;
    await withPluginMetadataSnapshotScope(
      managedSnapshot,
      async () => {
        await markAuthProfileBlockedUntil({
          store,
          agentDir,
          profileId: "local:default",
          blockedUntil: until,
          source: "wham",
        });
        await markInlineProviderApiKeyFailure({
          store,
          agentDir,
          provider: "local",
          reason: "billing",
        });
      },
      { trustConfigIdentity: true },
    );
    const persisted = ensureAuthProfileStore(agentDir);
    expect(persisted.usageStats?.["local:default"]).toMatchObject({
      blockedUntil: until,
      blockedReason: "subscription_limit",
    });
    expect(
      persisted.usageStats?.[resolveInlineProviderApiKeyUsageId("local")]?.disabledReason,
    ).toBe("billing");
  });
});

describe("provider-driven rate-limit cooldowns", () => {
  const model = "claude-test";
  const hour = 60 * 60_000;
  const reload = (agentDir: string) => {
    clearRuntimeAuthProfileStoreSnapshots();
    return ensureAuthProfileStore(agentDir);
  };

  it("cools a rate-limited model down for exactly the provider's retry window", async () => {
    const auth = fixture();
    const before = Date.now();
    const retryAfterMs = 36 * hour;
    await markAuthProfileFailure({
      ...auth,
      profileId,
      reason: "rate_limit",
      modelId: model,
      retryAfterMs,
    });
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
        markAuthProfileFailure({ ...auth, profileId, reason: "rate_limit", modelId: model }),
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
      markAuthProfileFailure({
        ...auth,
        profileId,
        reason: "rate_limit",
        modelId: model,
        retryAfterMs,
      });
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
    await markAuthProfileFailure({
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
