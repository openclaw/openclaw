import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createFailedOAuthRefreshFence, createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { resolveAuthProfileOrder } from "./order.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import {
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const PRIMARY = "openai:primary";
const BACKUP = "openai:backup";
const NOW = 2_000_000_000_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = createAuthProfileStoreRuntime({
  listRuntimeExternalAuthProfiles: () => [],
  overlayExternalAuthProfiles: (store) => store,
});

function credential(accountId: string, generation = "current"): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    accountId,
    access: `fixture-${accountId}-${generation}-access`,
    refresh: `fixture-${accountId}-${generation}-refresh`,
    expires: NOW + 60_000,
  };
}

function writeStore(store: AuthProfileStore, agentDir?: string) {
  // Preserve stale copies left by an older writer; current saves deduplicate shared OAuth.
  runAuthProfileWriteTransaction(agentDir, (database) => {
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: store.profiles }, agentDir, database);
    writePersistedAuthProfileStateRaw(
      {
        version: 1,
        order: store.order,
        lastGood: store.lastGood,
        usageStats: store.usageStats,
      },
      agentDir,
      database,
    );
  });
}

function order(store: AuthProfileStore) {
  return resolveAuthProfileOrder({
    store,
    provider: "openai",
    authAliasLookupParams: { metadataSnapshot: { plugins: [] } },
  });
}

describe("shared OAuth selection through agent-local copies", () => {
  let agentDir: string;
  beforeEach(() => {
    const stateDir = tempDirs.make("openclaw-auth-inherited-selection-");
    agentDir = path.join(stateDir, "agents", "child", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["sync", "async"] as const)(
    "selects a renewed shared primary through the %s runtime reader and prepared publication",
    async (reader) => {
      const primary = credential("primary");
      const backup = credential("backup");
      const shared: AuthProfileStore = {
        version: 1,
        profiles: { [PRIMARY]: primary, [BACKUP]: backup },
        order: { openai: [BACKUP, PRIMARY] },
        usageStats: {
          [BACKUP]: { blockedUntil: NOW + 60_000, blockedReason: "subscription_limit" },
        },
      };
      const local: AuthProfileStore = {
        version: 1,
        profiles: {
          [PRIMARY]: createFailedOAuthRefreshFence(
            createOAuthRefreshFence({
              profileId: PRIMARY,
              credential: credential("primary", "retired"),
            }),
          ),
          [BACKUP]: { ...credential("backup", "old"), expires: NOW - 60_000 },
        },
        order: { openai: [PRIMARY, BACKUP] },
        usageStats: {
          [BACKUP]: { blockedUntil: NOW - 60_000, blockedReason: "subscription_limit" },
        },
      };
      writeStore(shared);
      writeStore(local, agentDir);
      const loaded =
        reader === "async"
          ? await runtime.loadAuthProfileStoreForRuntimeAsync(agentDir, {
              externalCli: { mode: "none" },
            })
          : runtime.loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } });
      expect(order(loaded)).toEqual([PRIMARY, BACKUP]);
      expect(loaded.profiles).toEqual(shared.profiles);
      expect(loaded.usageStats).toEqual(shared.usageStats);
      expect(loaded.order).toEqual(local.order);
      expect(loaded).toMatchObject({ runtimeLocalProfileIds: [] });

      setRuntimeAuthProfileStoreSnapshot(shared);
      setRuntimeAuthProfileStoreSnapshot(local, agentDir);
      const published = getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir)!;
      expect(order(published)).toEqual([PRIMARY, BACKUP]);
      expect(published.profiles).toEqual(shared.profiles);
      expect(published.usageStats).toEqual(shared.usageStats);
      // Read-through recovery must not copy another refresh generation into the child owner.
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual(local.profiles);
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual(local.order);
    },
  );

  it("honors a shared cooldown even when an old child copy has an expired cooldown", () => {
    const primary = credential("primary");
    const shared: AuthProfileStore = {
      version: 1,
      profiles: { [PRIMARY]: primary, [BACKUP]: credential("backup") },
      usageStats: { [PRIMARY]: { cooldownUntil: NOW + 60_000 } },
    };
    writeStore(shared);
    writeStore(
      {
        version: 1,
        profiles: { [PRIMARY]: primary },
        order: { openai: [PRIMARY, BACKUP] },
        usageStats: { [PRIMARY]: { cooldownUntil: NOW - 60_000 } },
      },
      agentDir,
    );
    expect(order(runtime.loadAuthProfileStoreForRuntime(agentDir))).toEqual([BACKUP, PRIMARY]);
  });

  it.each(["different-account", "newer-generation"] as const)(
    "preserves the credential, health and authored order for a %s local owner",
    (kind) => {
      const shared: AuthProfileStore = {
        version: 1,
        profiles: { [PRIMARY]: credential("primary"), [BACKUP]: credential("backup") },
        order: { openai: [BACKUP, PRIMARY] },
        usageStats: { [PRIMARY]: { cooldownUntil: NOW + 60_000 } },
      };
      const local: AuthProfileStore = {
        version: 1,
        profiles: {
          [PRIMARY]: {
            ...credential(kind === "different-account" ? "local-account" : "primary", "local"),
            expires: NOW + 120_000,
          },
          unrelated: { type: "api_key", provider: "custom", key: "fixture-key" },
        },
        order: { openai: [PRIMARY, BACKUP] },
        lastGood: { custom: "unrelated" },
        usageStats: { [PRIMARY]: { lastUsed: NOW }, unrelated: { errorCount: 2 } },
      };
      writeStore(shared);
      writeStore(local, agentDir);
      const loaded = runtime.loadAuthProfileStoreForRuntime(agentDir);
      expect(loaded.profiles[PRIMARY]).toEqual(local.profiles[PRIMARY]);
      expect(loaded.usageStats).toEqual(local.usageStats);
      expect(loaded.order).toEqual(local.order);
      expect(loaded.lastGood).toEqual(local.lastGood);
      expect(loaded).toMatchObject({ runtimeLocalProfileIds: [PRIMARY, "unrelated"] });
      expect(order(loaded)).toEqual([PRIMARY, BACKUP]);
    },
  );
});
