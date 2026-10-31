import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import { resolveAuthProfileOrder } from "./order.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { markAuthProfileSuccess, removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { writePersistedAuthProfileStateRaw, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import {
  findPersistedAuthProfileCredential,
  withAuthProfileStoreAgentDir,
  withEnvOnlyAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";
import { markAuthProfileBlockedUntil, markAuthProfileFailure } from "./usage.js";

const PRIMARY_ID = "openai:primary";
const BACKUP_ID = "openai:backup";
const LOCAL_ID = "openai:local";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

function createMainStore(): AuthProfileStore {
  const expires = Date.now() + 30 * 60 * 1000;
  return {
    version: 1,
    profiles: Object.fromEntries(
      ["primary", "backup"].map((name) => [
        `openai:${name}`,
        createOAuthRefreshCredential({
          access: `${name}-access`,
          refresh: `${name}-refresh`,
          expires,
        }),
      ]),
    ),
    order: { openai: [PRIMARY_ID, BACKUP_ID] },
  };
}

describe("inherited auth-profile usage persistence", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR"]);
  let rootDir: string;
  let mainAgentDir: string;
  let childAgentDir: string;

  beforeEach(() => {
    resetFileLockStateForTest();
    rootDir = tempDirs.make("inherited-auth-owner-");
    mainAgentDir = path.join(rootDir, "agents", "main", "agent");
    childAgentDir = path.join(rootDir, "agents", "child", "agent");
    fs.mkdirSync(mainAgentDir, { recursive: true });
    fs.mkdirSync(childAgentDir, { recursive: true });
    setTestEnvValue("OPENCLAW_STATE_DIR", rootDir);
    setTestEnvValue("OPENCLAW_AGENT_DIR", mainAgentDir);
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetFileLockStateForTest();
    env.restore();
  });

  function writeMainStore(store = createMainStore()): void {
    saveAuthProfileStore(store, mainAgentDir, saveOptions);
  }

  function createChildStore(cooldownUntil: number) {
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { [LOCAL_ID]: { type: "api_key", provider: "openai", key: "local-key" } },
        usageStats: { [LOCAL_ID]: { cooldownUntil } },
      },
      childAgentDir,
      saveOptions,
    );
    return ensureAuthProfileStore(childAgentDir);
  }

  function connectPersonalAccount(ownerProfileId: string): string {
    return connectUserModelAccount({
      ownerProfileId,
      credential: { type: "token", provider: "anthropic", token: "synthetic-personal-token" },
      assertCurrent() {},
    }).authProfileId;
  }

  const fail = (
    store: AuthProfileStore,
    profileId: string,
    reason: "rate_limit" | "timeout",
    agentDir = childAgentDir,
  ) => markAuthProfileFailure({ store, profileId, reason, agentDir });
  const succeed = (
    store: AuthProfileStore,
    profileId: string,
    provider = "openai",
    agentDir = childAgentDir,
  ) => markAuthProfileSuccess({ store, profileId, provider, agentDir });

  it.each(["shared", "inherited", "personal"] as const)(
    "keeps a newer %s success over an older exhausted WHAM reply",
    async (owner) => {
      writeMainStore();
      const credential = createMainStore().profiles[PRIMARY_ID]!;
      const profileId =
        owner === "personal"
          ? connectUserModelAccount({
              ownerProfileId: ensureProfileForEmail("quota@example.test").id,
              credential,
              assertCurrent() {},
            }).authProfileId
          : PRIMARY_ID;
      const agentDir = owner === "shared" ? mainAgentDir : childAgentDir;
      const store = ensureAuthProfileStore(agentDir, { profileId });
      const readStats = () =>
        owner === "personal"
          ? readUserModelAuthProfile(profileId)?.usageStats
          : loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[profileId];
      const exhausted = () =>
        Response.json({
          rate_limit: {
            limit_reached: true,
            primary_window: { used_percent: 100, reset_after_seconds: 3600 },
          },
        });
      const arrived = createDeferredCore();
      const reply = createDeferredCore<Response>();
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
        arrived.resolve();
        return reply.promise;
      });
      const observedAt = Date.now() - 60_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(observedAt);
      const olderFailure = fail(store, profileId, "rate_limit", agentDir);
      void olderFailure.catch(() => {});
      try {
        await awaitGateBeforeSettlement(arrived.promise, olderFailure, "WHAM probe did not start");
        clock.mockRestore();
        await succeed(store, profileId, "openai", agentDir);
        const success = readStats();
        expect(success?.lastProbeAt).toBeGreaterThan(observedAt);
        reply.resolve(exhausted());
        await olderFailure;
        expect(readStats()).toEqual(success);
        expect(store.usageStats?.[profileId]).toEqual(success);

        fetch.mockResolvedValueOnce(exhausted());
        await fail(store, profileId, "rate_limit", agentDir);
        expect(readStats()).toMatchObject({
          blockedReason: "subscription_limit",
          blockedSource: "wham",
        });
      } finally {
        clock.mockRestore();
        reply.resolve(exhausted());
        await olderFailure;
      }
    },
  );

  it("keeps selected personal health in its owner without publishing credentials or selection", async () => {
    writeMainStore();
    const owner = ensureProfileForEmail("alice@example.test");
    const aliceId = connectPersonalAccount(owner.id);
    const bobId = connectPersonalAccount(ensureProfileForEmail("bob@example.test").id);
    const turnStore = ensureAuthProfileStore(childAgentDir, { profileId: aliceId });
    expect(turnStore.profiles[aliceId]?.provider).toBe("anthropic");
    expect(turnStore.profiles[bobId]).toBeUndefined();

    await fail(turnStore, aliceId, "timeout");
    expect(readUserModelAuthProfile(aliceId)?.usageStats?.cooldownUntil).toBeTypeOf("number");
    await succeed(turnStore, aliceId, "anthropic");
    expect(readUserModelAuthProfile(aliceId)?.usageStats).toMatchObject({
      errorCount: 0,
      lastUsed: expect.any(Number),
    });
    expect(readUserModelAuthProfile(aliceId)?.usageStats?.cooldownUntil).toBeUndefined();
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[aliceId]).toBeUndefined();

    turnStore.order = { ...turnStore.order, anthropic: [aliceId] };
    turnStore.lastGood = { anthropic: aliceId };
    saveAuthProfileStore(turnStore, childAgentDir, {
      filterExternalAuthProfiles: false,
      preserveOrderProfileIds: [aliceId],
      preserveStateProfileIds: [aliceId],
    });
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[aliceId]).toBeUndefined();
    expect(persistedChild?.usageStats?.[aliceId]).toBeUndefined();
    expect(persistedChild?.order?.anthropic).toBeUndefined();
    expect(persistedChild?.lastGood?.anthropic).toBeUndefined();

    setRuntimeAuthProfileStoreSnapshot(turnStore, childAgentDir);
    expect(ensureAuthProfileStore(childAgentDir).profiles[aliceId]).toBeUndefined();
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: childAgentDir, store: turnStore }]);
    expect(ensureAuthProfileStore(childAgentDir).profiles[aliceId]).toBeUndefined();
  });

  it("preserves shared custom IDs across storage, publication, and bookkeeping", async () => {
    const profileId = "personal:work";
    writeMainStore();
    const owner = ensureProfileForEmail("missing-account@example.test");
    const missingId = `personal:${owner.id}:${randomUUID()}`;
    const shared: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: { type: "api_key", provider: "anthropic", key: "synthetic-shared-key" },
      },
      order: { anthropic: [profileId] },
      lastGood: { anthropic: profileId },
      usageStats: { [profileId]: { lastUsed: 1 } },
    };
    const contaminated: AuthProfileStore = {
      ...shared,
      profiles: {
        ...shared.profiles,
        [missingId]: { type: "api_key", provider: "xai", key: "synthetic-stale-private-copy" },
      },
      order: { ...shared.order, xai: [missingId] },
      lastGood: { ...shared.lastGood, xai: missingId },
      usageStats: { ...shared.usageStats, [missingId]: { lastUsed: 2 } },
    };
    // Seed the canonical DB as an older writer would, bypassing this version's filters.
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: contaminated.profiles });
    writePersistedAuthProfileStateRaw({
      version: 1,
      order: contaminated.order,
      lastGood: contaminated.lastGood,
      usageStats: contaminated.usageStats,
    });
    closeOpenClawStateDatabaseForTest();

    const expectSharedOnly = (store: AuthProfileStore | null | undefined) => {
      expect(store?.profiles).toEqual(shared.profiles);
      expect(store?.order).toEqual(shared.order);
      expect(store?.lastGood).toEqual(shared.lastGood);
      expect(store?.usageStats).toEqual(shared.usageStats);
    };
    const loaded = ensureAuthProfileStore(mainAgentDir);
    expectSharedOnly(loaded);
    expect(findPersistedAuthProfileCredential({ profileId })).toEqual(shared.profiles[profileId]);
    expect(findPersistedAuthProfileCredential({ profileId: missingId })).toBeUndefined();

    saveAuthProfileStore(contaminated, mainAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
      preserveOrderProfileIds: [profileId, missingId],
      preserveStateProfileIds: [profileId, missingId],
    });
    closeOpenClawStateDatabaseForTest();
    expectSharedOnly(loadPersistedAuthProfileStore(mainAgentDir));
    setRuntimeAuthProfileStoreSnapshot(contaminated, mainAgentDir);
    expectSharedOnly(ensureAuthProfileStore(mainAgentDir));
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: mainAgentDir, store: contaminated }]);
    expectSharedOnly(ensureAuthProfileStore(mainAgentDir));

    await succeed(loaded, profileId, "anthropic", mainAgentDir);
    expect(
      loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[profileId]?.lastUsed,
    ).toBeGreaterThan(1);
    await removeAuthProfilesAcrossOwnerStores({
      profileIds: [profileId],
      agentDir: mainAgentDir,
    });
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toBeUndefined();
  });

  it("does not carry personal credentials into isolated auth scopes", async () => {
    const personalId = connectPersonalAccount(ensureProfileForEmail("alice@example.test").id);
    expect(
      withEnvOnlyAuthProfileStore(
        () => ensureAuthProfileStore(childAgentDir, { profileId: personalId }).profiles[personalId],
      ),
    ).toBeUndefined();
    await withAuthProfileStoreAgentDir(childAgentDir, rootDir, () => {
      expect(
        ensureAuthProfileStore(childAgentDir, { profileId: personalId }).profiles[personalId],
      ).toBeUndefined();
      expect(
        findPersistedAuthProfileCredential({ agentDir: childAgentDir, profileId: personalId }),
      ).toBeUndefined();
    });
  });

  it("rejects personal account removal through the shared CLI boundary without deleting shared profiles", async () => {
    writeMainStore();
    const personalId = connectPersonalAccount(ensureProfileForEmail("alice@example.test").id);

    await expect(
      removeAuthProfilesAcrossOwnerStores({
        agentDir: mainAgentDir,
        profileIds: [PRIMARY_ID, personalId],
      }),
    ).rejects.toThrow(
      "Personal model accounts are managed in Settings → Profile → Connected accounts",
    );
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[PRIMARY_ID]).toBeDefined();
    expect(readUserModelAuthProfile(personalId)?.credential).toBeDefined();
  });

  it("keeps an inherited primary blocked for the next child run", async () => {
    writeMainStore();
    const localCooldownUntil = Date.now() + 30 * 60 * 1000;
    const childStore = createChildStore(localCooldownUntil);
    const blockedUntil = Date.now() + 60 * 60 * 1000;

    await markAuthProfileBlockedUntil({
      store: childStore,
      profileId: PRIMARY_ID,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: childAgentDir,
      modelId: "gpt-5.6-sol",
    });

    expect(childStore.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);

    clearRuntimeAuthProfileStoreSnapshots();
    const nextRunStore = ensureAuthProfileStore(childAgentDir);
    expect({
      ownerBlockedUntil:
        loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[PRIMARY_ID]?.blockedUntil,
      nextRunOrder: resolveAuthProfileOrder({ store: nextRunStore, provider: "openai" }),
    }).toEqual({
      ownerBlockedUntil: blockedUntil,
      nextRunOrder: [BACKUP_ID, LOCAL_ID, PRIMARY_ID],
    });
  });

  it("clears inherited health without changing selection ownership", async () => {
    const lastUsed = Date.now() - 60_000;
    const mainStore = createMainStore();
    mainStore.lastGood = { openai: BACKUP_ID };
    mainStore.usageStats = {
      [PRIMARY_ID]: {
        lastUsed,
        errorCount: 12,
        failureCounts: { timeout: 12 },
        lastRateLimitAt: lastUsed,
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownClassification: "wham_token_expired",
      },
    };
    writeMainStore(mainStore);
    const localCooldownUntil = Date.now() + 30_000;
    const childStore = createChildStore(localCooldownUntil);

    await succeed(childStore, PRIMARY_ID);

    const persistedMain = loadPersistedAuthProfileStore(mainAgentDir);
    expect(persistedMain?.lastGood?.openai).toBe(BACKUP_ID);
    expect(persistedMain?.usageStats?.[PRIMARY_ID]).toMatchObject({
      lastUsed,
      errorCount: 0,
    });
    for (const field of [
      "failureCounts",
      "lastRateLimitAt",
      "cooldownUntil",
      "cooldownClassification",
    ]) {
      expect(persistedMain?.usageStats?.[PRIMARY_ID]).not.toHaveProperty(field);
    }
    expect(childStore.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);
    expect(childStore.usageStats?.[PRIMARY_ID]).toMatchObject({
      errorCount: 0,
      failureCounts: undefined,
      cooldownUntil: undefined,
    });
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.usageStats?.[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.lastGood?.openai).toBeUndefined();
  });
});
