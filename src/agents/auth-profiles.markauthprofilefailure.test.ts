import { afterAll, assert, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
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
import {
  ensureAuthProfileStore as loadStore,
  saveAuthProfileStore as saveStore,
} from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
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
vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
  }),
}));

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
  await markFailure({ ...auth, profileId, reason: "rate_limit" });
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

it.each([
  { reason: "billing", age: 48 * 60 * 60_000, errors: 9, failures: 1, delay: 600_000 },
  { reason: "rate_limit", age: 120_000, errors: 3, failures: 4, delay: 240_000 },
] as const)("resets stale $reason backoff and preserves its deadline on retry", async (row) => {
  const now = Date.now();
  const { reason, age, errors, failures, delay } = row;
  const field = reason === "billing" ? "disabledUntil" : "cooldownUntil";
  const auth = fixture({
    [profileId]: {
      errorCount: errors,
      failureCounts: { [reason]: 3 },
      lastFailureAt: now - age,
      ...(reason === "rate_limit" ? { cooldownUntil: now - 60_000 } : {}),
    },
  });
  const fail = () => markFailure({ ...auth, profileId, reason });
  await fail();
  const first = auth.store.usageStats?.[profileId];
  expect(first).toMatchObject({ errorCount: 1, failureCounts: { [reason]: failures } });
  assert(first?.lastFailureAt !== undefined);
  expect(first.lastFailureAt).toBeGreaterThanOrEqual(now);
  expect(first.lastFailureAt).toBeLessThanOrEqual(Date.now());
  const deadline = first[field];
  expect(deadline).toBe(first.lastFailureAt + delay);
  await fail();
  expect(auth.store.usageStats?.[profileId]?.[field]).toBe(deadline);
  expect(loadStore(auth.agentDir).usageStats?.[profileId]?.[field]).toBe(deadline);
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
