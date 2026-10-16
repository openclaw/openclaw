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
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
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
    await markAuthProfileFailure({ store, agentDir, profileId, reason: "rate_limit" });
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

  it("backs off an expired rate-limit probe without extending its deadline on retry", async () => {
    const now = Date.now();
    const { store, agentDir } = fixture({
      [profileId]: {
        errorCount: 3,
        failureCounts: { rate_limit: 3 },
        lastFailureAt: now - 120_000,
        cooldownUntil: now - 60_000,
      },
    });
    const fail = () => markAuthProfileFailure({ store, agentDir, profileId, reason: "rate_limit" });
    await fail();
    const first = store.usageStats?.[profileId];
    expect(first?.errorCount).toBe(1);
    expect(first?.failureCounts?.rate_limit).toBe(4);
    assert(first?.lastFailureAt !== undefined);
    expect(first.lastFailureAt).toBeGreaterThanOrEqual(now);
    expect(first.lastFailureAt).toBeLessThanOrEqual(Date.now());
    expect(first.cooldownUntil).toBe(first.lastFailureAt + 240_000);
    const deadline = first?.cooldownUntil;
    await fail();
    expect(store.usageStats?.[profileId]?.cooldownUntil).toBe(deadline);
    expect(ensureAuthProfileStore(agentDir).usageStats?.[profileId]?.cooldownUntil).toBe(deadline);
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
