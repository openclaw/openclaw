import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { createApiKeyCredential as apiKey, oauthCred } from "./credential-fixtures.test-support.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  getRuntimeAuthProfileStoreStateMutationToken,
} from "./mutation-lineage.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { reloadSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore as loadPersisted } from "./persisted.js";
import {
  expectOAuthCredentialFields,
  failNextRuntimeAuthSnapshotPublication,
  withAuthProfileTestState,
} from "./profile-mutations.test-support.js";
import {
  clearLastGoodProfileWithLock,
  markAuthProfileSuccess,
  promoteAuthProfileInOrder,
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
  setAuthProfileOrder,
  upsertAuthProfileWithLock,
} from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots as publishSnapshots,
} from "./runtime-snapshots.js";
import { runAuthProfileWriteTransaction, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime as loadRuntime,
  loadAuthProfileStoreWithoutExternalProfiles as loadLocal,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
  saveAuthProfileStore,
} from "./store-runtime.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  getRuntimeAuthProfileStoreSnapshot as runtimeSnapshot,
  restoreAuthProfileStorePersistenceSnapshot,
} from "./store.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

function oauth(
  access: string,
  refresh: string,
  expires = Date.now() + 60_000,
  provider = "openai",
) {
  return oauthCred({ provider, access, refresh, expires });
}

function withProfileState(
  run: Parameters<typeof withAuthProfileTestState>[1],
  clearOAuthDir = false,
) {
  return withAuthProfileTestState("auth-profiles-", run, { clearOAuthDir });
}

function saveProfiles(
  profiles: AuthProfileStore["profiles"],
  agentDir?: string,
  extra: Omit<RuntimeAuthProfileStore, "version" | "profiles"> = {},
) {
  saveAuthProfileStore(makeStore(profiles, extra), agentDir);
}

function profileStore(
  profileId: string,
  credential: AuthProfileStore["profiles"][string],
  extra: Omit<RuntimeAuthProfileStore, "version" | "profiles"> = {},
) {
  return makeStore({ [profileId]: credential }, extra);
}

function saveProfile(
  profileId: string,
  credential: AuthProfileStore["profiles"][string],
  agentDir?: string,
  extra: Omit<RuntimeAuthProfileStore, "version" | "profiles"> = {},
) {
  saveAuthProfileStore(profileStore(profileId, credential, extra), agentDir);
}

function makeStore(
  profiles: AuthProfileStore["profiles"],
  extra: Omit<RuntimeAuthProfileStore, "version" | "profiles"> = {},
): RuntimeAuthProfileStore {
  return { version: AUTH_STORE_VERSION, profiles, ...extra };
}

vi.mock("../provider-auth-aliases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-auth-aliases.js")>();
  return {
    ...actual,
    resolveProviderIdForAuth: (...args: Parameters<typeof actual.resolveProviderIdForAuth>) => {
      const provider = args[0].trim().toLowerCase();
      return provider === "gmi-cloud" || provider === "gmicloud"
        ? "gmi"
        : actual.resolveProviderIdForAuth(...args);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("promoteAuthProfileInOrder", () => {
  it("refreshes inherited main selection state without advancing credential ownership", () =>
    withProfileState(async ({ agentDirFor }) => {
      const customAgentDir = agentDirFor("custom");
      fs.mkdirSync(customAgentDir, { recursive: true });
      const mainStore = (selected: string): AuthProfileStore =>
        makeStore(
          {
            "openai:first": apiKey("openai", "sk-first"),
            "openai:second": apiKey("openai", "sk-second"),
          },
          { order: { openai: [selected] } },
        );
      saveAuthProfileStore(mainStore("openai:first"));
      publishSnapshots([
        {
          agentDir: customAgentDir,
          store: loadRuntime(customAgentDir),
        },
      ]);
      const credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();

      saveAuthProfileStore(mainStore("openai:second"));

      expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(credentialsRevision);
      expect(runtimeSnapshot(customAgentDir)?.order?.openai).toEqual(["openai:second"]);
    }, true));

  it("rebuilds a derived custom-agent snapshot after locked main OAuth rotation", () =>
    withProfileState(async ({ agentDirFor }) => {
      const customAgentDir = agentDirFor("custom");
      fs.mkdirSync(customAgentDir, { recursive: true });
      const mainStore = (access: string): AuthProfileStore =>
        profileStore("openai:default", oauth(access, `refresh-${access}`));
      saveAuthProfileStore(mainStore("old"));
      saveProfile(
        "anthropic:custom",
        {
          type: "api_key",
          provider: "anthropic",
          keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
          key: "sk-custom-resolved",
        },
        customAgentDir,
      );
      const derivedStore = loadRuntime(customAgentDir);
      const customCredential = derivedStore.profiles["anthropic:custom"];
      if (customCredential?.type !== "api_key") {
        throw new Error("expected custom API-key profile");
      }
      customCredential.key = "sk-custom-resolved";
      publishSnapshots([{ agentDir: customAgentDir, store: derivedStore }]);
      expect(runtimeSnapshot(customAgentDir)?.profiles["openai:default"]).toMatchObject({
        access: "old",
      });

      await persistAuthProfileBatch({
        profiles: [
          {
            profileId: "openai:default",
            credential: oauth("new", "refresh-new"),
          },
        ],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });

      expect(runtimeSnapshot(customAgentDir)?.profiles["openai:default"]).toMatchObject({
        access: "new",
        refresh: "refresh-new",
      });
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(customAgentDir).profiles["anthropic:custom"],
      ).toMatchObject({
        key: "sk-custom-resolved",
        keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
      });
    }, true));

  it("keeps inherited resolved credentials when publishing a locked custom-agent save", () =>
    withProfileState(async ({ agentDirFor }) => {
      const customAgentDir = agentDirFor("custom");
      fs.mkdirSync(customAgentDir, { recursive: true });
      saveProfile("anthropic:inherited", {
        type: "api_key",
        provider: "anthropic",
        keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
      });
      saveProfile("openai:local", apiKey("openai", "sk-local-old"), customAgentDir);
      const runtimeStore = loadRuntime(customAgentDir);
      const inherited = runtimeStore.profiles["anthropic:inherited"];
      if (inherited?.type !== "api_key") {
        throw new Error("expected inherited API-key profile");
      }
      inherited.key = "sk-inherited-resolved";
      publishSnapshots([{ agentDir: customAgentDir, store: runtimeStore }]);

      externalAuthTesting.setResolveExternalAuthProfilesForTest(() => {
        throw new Error("external auth hook must not run during postcommit rebuild");
      });
      try {
        await expect(
          upsertAuthProfileWithLock({
            agentDir: customAgentDir,
            profileId: "openai:local",
            credential: { type: "api_key", provider: "openai", key: "sk-local-new" },
          }),
        ).resolves.not.toBeNull();
      } finally {
        externalAuthTesting.resetResolveExternalAuthProfilesForTest();
      }

      expect(runtimeSnapshot(customAgentDir)?.profiles["anthropic:inherited"]).toMatchObject({
        key: "sk-inherited-resolved",
        keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
      });
      expect(runtimeSnapshot(customAgentDir)?.profiles["openai:local"]).toMatchObject({
        key: "sk-local-new",
      });
    }, true));

  it("isolates postcommit publication failure to the saving owner", () =>
    withProfileState(async ({ agentDirFor }) => {
      const savingAgentDir = agentDirFor("saving");
      const siblingAgentDir = agentDirFor("sibling");
      const siblingStore: RuntimeAuthProfileStore = profileStore(
        "anthropic:sibling",
        apiKey("anthropic", "sk-sibling"),
        { runtimeLocalProfileIds: ["anthropic:sibling"] },
      );
      saveProfile("openai:saving", apiKey("openai", "sk-old"), savingAgentDir);
      publishSnapshots([
        { agentDir: savingAgentDir, store: loadRuntime(savingAgentDir) },
        { agentDir: siblingAgentDir, store: siblingStore },
      ]);
      failNextRuntimeAuthSnapshotPublication();

      saveProfile("openai:saving", apiKey("openai", "sk-new"), savingAgentDir);

      expect(runtimeSnapshot(savingAgentDir)).toBeUndefined();
      expect(loadPersisted(savingAgentDir)?.profiles["openai:saving"]).toMatchObject({
        key: "sk-new",
      });
      expect(runtimeSnapshot(siblingAgentDir)).toEqual(siblingStore);
    }));

  it("converges unreadable derived owners on committed shared credentials", () =>
    withProfileState(async ({ agentDirFor }) => {
      const brokenAgentDir = agentDirFor("broken");
      const healthyAgentDir = agentDirFor("healthy");
      const sharedStore = (profileId: string, key: string): AuthProfileStore =>
        profileStore(profileId, apiKey("openai", key));
      saveAuthProfileStore(sharedStore("openai:shared", "sk-shared-old"));
      saveProfile("anthropic:broken", apiKey("anthropic", "sk-broken-local"), brokenAgentDir);
      saveProfile("google:healthy", apiKey("google", "sk-healthy-local"), healthyAgentDir);
      publishSnapshots([
        { agentDir: brokenAgentDir, store: loadRuntime(brokenAgentDir) },
        { agentDir: healthyAgentDir, store: loadRuntime(healthyAgentDir) },
      ]);
      writePersistedAuthProfileStoreRaw(
        { version: AUTH_STORE_VERSION, profiles: "invalid-profile-map" },
        brokenAgentDir,
      );

      saveAuthProfileStore(sharedStore("openai:shared", "sk-shared-new"));

      const brokenAfterRotation = runtimeSnapshot(brokenAgentDir);
      const healthyAfterRotation = runtimeSnapshot(healthyAgentDir);
      const resolveKey = (
        store: RuntimeAuthProfileStore,
        agentDir: string,
        profileId = "openai:shared",
      ) => resolveApiKeyForProfile({ cfg: {}, store, profileId, agentDir });
      expect(brokenAfterRotation).toBeDefined();
      expect(healthyAfterRotation).toBeDefined();
      await expect(resolveKey(brokenAfterRotation!, brokenAgentDir)).resolves.toMatchObject({
        apiKey: "sk-shared-new",
      });
      await expect(resolveKey(healthyAfterRotation!, healthyAgentDir)).resolves.toMatchObject({
        apiKey: "sk-shared-new",
      });
      expect(brokenAfterRotation?.profiles["anthropic:broken"]).toMatchObject({
        key: "sk-broken-local",
      });
      expect(healthyAfterRotation?.profiles["google:healthy"]).toMatchObject({
        key: "sk-healthy-local",
      });

      saveAuthProfileStore(sharedStore("openai:replacement", "sk-shared-replacement"));

      const brokenAfterDeletion = runtimeSnapshot(brokenAgentDir);
      expect(brokenAfterDeletion).toBeDefined();
      await expect(resolveKey(brokenAfterDeletion!, brokenAgentDir)).resolves.toBeNull();
      await expect(
        resolveKey(brokenAfterDeletion!, brokenAgentDir, "openai:replacement"),
      ).resolves.toMatchObject({ apiKey: "sk-shared-replacement" });
    }, true));

  it("preserves derived runtime snapshots on a caller-owned main-store no-op", () =>
    withProfileState(async ({ agentDir, agentDirFor }) => {
      const derivedAgentDir = agentDirFor("worker");
      const mainStore: AuthProfileStore = profileStore(
        "openai:default",
        apiKey("openai", "sk-main"),
      );
      saveAuthProfileStore(mainStore, agentDir);
      const derivedStore = loadRuntime(derivedAgentDir);
      publishSnapshots([
        { agentDir, store: loadRuntime(agentDir) },
        { agentDir: derivedAgentDir, store: derivedStore },
      ]);

      runAuthProfileWriteTransaction(agentDir, (database) => {
        saveAuthProfileStore(mainStore, agentDir, undefined, database);
      });

      expect(runtimeSnapshot(derivedAgentDir)).toEqual(derivedStore);
    }));

  it("drops caller-owned publication when a nested savepoint rolls back", () =>
    withProfileState(async ({ agentDir }) => {
      const initial: AuthProfileStore = profileStore(
        "openai:default",
        apiKey("openai", "sk-initial"),
      );
      const candidate: AuthProfileStore = profileStore(
        "openai:default",
        apiKey("openai", "sk-candidate"),
      );
      saveAuthProfileStore(initial, agentDir);
      publishSnapshots([{ agentDir, store: initial }]);

      runAuthProfileWriteTransaction(agentDir, () => {
        expect(() =>
          runAuthProfileWriteTransaction(agentDir, (database) => {
            saveAuthProfileStore(candidate, agentDir, undefined, database);
            throw new Error("rollback savepoint");
          }),
        ).toThrow("rollback savepoint");
      });

      expect(loadPersisted(agentDir)).toMatchObject(initial);
      expect(runtimeSnapshot(agentDir)).toEqual(initial);
    }));

  it("does not persist runtime-only external profiles", () =>
    withProfileState(async ({ agentDir }) => {
      const profileId = "openai:default";
      const runtimeStore: RuntimeAuthProfileStore = profileStore(
        profileId,
        oauth("external-access", "external-refresh"),
        { runtimeExternalProfileIds: [profileId] },
      );
      publishSnapshots([{ agentDir, store: runtimeStore }]);

      saveAuthProfileStore(runtimeStore, agentDir);

      const persisted = loadPersisted(agentDir);
      expect(persisted?.profiles[profileId]).toBeUndefined();
    }));

  it.each(["before save", "before publication"] as const)(
    "preserves a runtime-only OAuth mutation %s",
    async (mutationTiming) => {
      await withProfileState(async ({ agentDir }) => {
        const baselineStore: AuthProfileStore = makeStore(
          {
            "openai:baseline": apiKey("openai", "sk-baseline"),
            "anthropic:external": oauth(
              "external-before-capture",
              "external-refresh",
              undefined,
              "anthropic",
            ),
          },
          { runtimeExternalProfileIds: ["anthropic:external"] },
        );
        saveAuthProfileStore(baselineStore, agentDir);
        publishSnapshots([{ agentDir, store: baselineStore }]);
        const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);

        const mutateRuntimeStore = () => {
          publishSnapshots([
            {
              agentDir,
              store: {
                ...baselineStore,
                profiles: {
                  ...baselineStore.profiles,
                  "anthropic:external": oauth(
                    "external-after-capture",
                    "external-refresh-new",
                    Date.now() + 120_000,
                    "anthropic",
                  ),
                },
              },
            },
          ]);
        };
        if (mutationTiming === "before save") {
          mutateRuntimeStore();
        }
        const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
          snapshot,
          agentDir,
          store: profileStore("openai:temporary", apiKey("openai", "sk-temporary")),
        });
        if (mutationTiming === "before publication") {
          mutateRuntimeStore();
        }
        expect(committed.publishRuntimeSnapshots()).toBe(true);
        const { owned } = committed;

        restoreAuthProfileStorePersistenceSnapshot(snapshot, owned, agentDir);

        expect(runtimeSnapshot(agentDir)?.profiles).toMatchObject({
          "openai:baseline": { key: "sk-baseline" },
          "anthropic:external": {
            access: "external-after-capture",
            refresh: "external-refresh-new",
          },
        });
        expect(runtimeSnapshot(agentDir)?.profiles["openai:temporary"]).toBeUndefined();
      }, true);
    },
  );

  it("restores captured and rebuilds newer derived snapshots after main rollback", () =>
    withProfileState(async ({ agentDirFor }) => {
      const capturedAgentDir = agentDirFor("captured");
      const newerAgentDir = agentDirFor("newer");
      const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
      saveProfile("openai:baseline", { type: "api_key", provider: "openai", keyRef });
      const capturedRuntime = loadRuntime(capturedAgentDir);
      const capturedProfile = capturedRuntime.profiles["openai:baseline"];
      if (capturedProfile?.type !== "api_key") {
        throw new Error("expected captured derived API-key profile");
      }
      capturedProfile.key = "sk-captured-resolved";
      capturedRuntime.profiles["anthropic:captured-external"] = oauth(
        "captured-external-access",
        "captured-external-refresh",
        undefined,
        "anthropic",
      );
      capturedRuntime.runtimeExternalProfileIds = ["anthropic:captured-external"];
      publishSnapshots([{ agentDir: capturedAgentDir, store: capturedRuntime }]);
      const snapshot = captureAuthProfileStorePersistenceSnapshot();

      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot,
        store: profileStore("openai:temporary", apiKey("openai", "sk-temporary")),
      });
      capturedRuntime.profiles["anthropic:captured-external"] = oauth(
        "captured-publication-edge-access",
        "captured-publication-edge-refresh",
        Date.now() + 120_000,
        "anthropic",
      );
      publishSnapshots([{ agentDir: capturedAgentDir, store: capturedRuntime }]);
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      const { owned } = committed;
      const ownedCapturedRuntime = runtimeSnapshot(capturedAgentDir);
      if (!ownedCapturedRuntime) {
        throw new Error("expected apply-owned derived runtime snapshot");
      }
      expect(ownedCapturedRuntime.profiles["openai:baseline"]).toBeUndefined();
      expect(ownedCapturedRuntime.profiles["anthropic:captured-external"]).toMatchObject({
        access: "captured-publication-edge-access",
        refresh: "captured-publication-edge-refresh",
      });
      const newerRuntime = loadRuntime(newerAgentDir);
      newerRuntime.profiles["anthropic:newer-external"] = oauth(
        "newer-external-access",
        "newer-external-refresh",
        undefined,
        "anthropic",
      );
      newerRuntime.runtimeExternalProfileIds = ["anthropic:newer-external"];
      publishSnapshots([
        { agentDir: capturedAgentDir, store: ownedCapturedRuntime },
        { agentDir: newerAgentDir, store: newerRuntime },
      ]);

      restoreAuthProfileStorePersistenceSnapshot(snapshot, owned);

      expect(runtimeSnapshot(capturedAgentDir)?.profiles).toMatchObject({
        "openai:baseline": { key: "sk-captured-resolved", keyRef },
        "anthropic:captured-external": {
          access: "captured-publication-edge-access",
          refresh: "captured-publication-edge-refresh",
        },
      });
      expect(runtimeSnapshot(capturedAgentDir)?.profiles["openai:temporary"]).toBeUndefined();
      expect(runtimeSnapshot(newerAgentDir)?.profiles).toMatchObject({
        "openai:baseline": { keyRef },
        "anthropic:newer-external": { access: "newer-external-access" },
      });
      expect(runtimeSnapshot(newerAgentDir)?.profiles["openai:temporary"]).toBeUndefined();
    }, true));

  it("restores an exactly owned derived snapshot under its custom database key", () =>
    withProfileState(async ({ agentDirFor }) => {
      const derivedAgentDir = agentDirFor("custom-key");
      const databasePath = path.join(derivedAgentDir, "custom.sqlite");
      saveProfile("openai:baseline", apiKey("openai", "sk-baseline"));
      const capturedRuntime = loadRuntime(derivedAgentDir);
      publishSnapshots([{ databasePath, agentDir: derivedAgentDir, store: capturedRuntime }]);
      const snapshot = captureAuthProfileStorePersistenceSnapshot();
      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot,
        store: profileStore("openai:temporary", apiKey("openai", "sk-temporary")),
      });

      expect(committed.publishRuntimeSnapshots()).toBe(true);
      expect(listOwnedRuntimeAuthProfileStoreSnapshots()).toMatchObject([
        { databasePath, store: { profiles: { "openai:temporary": { key: "sk-temporary" } } } },
      ]);

      restoreAuthProfileStorePersistenceSnapshot(snapshot, committed.owned);

      expect(listOwnedRuntimeAuthProfileStoreSnapshots()).toMatchObject([
        { databasePath, store: { profiles: { "openai:baseline": { key: "sk-baseline" } } } },
      ]);
    }));

  it("normalizes copied secrets when using the locked upsert path", () =>
    withProfileState(async ({ agentDirFor }) => {
      const agentDir = agentDirFor("work");
      fs.mkdirSync(agentDir, { recursive: true });

      await upsertAuthProfileWithLock({
        profileId: "openai:manual",
        credential: { type: "token", provider: "openai", token: "  bearer\r\n-token\u2502  " },
        agentDir,
      });
      await upsertAuthProfileWithLock({
        profileId: "anthropic:key",
        credential: apiKey("anthropic", "  sk-\r\nant\u2502  "),
        agentDir,
      });

      const store = loadLocal(agentDir) as RuntimeAuthProfileStore;
      expect(store.runtimePersistedProfileIds).toEqual(["anthropic:key", "openai:manual"]);
      expect(store.runtimeLocalProfileIds).toEqual(["anthropic:key", "openai:manual"]);
      expect(store.runtimeExternalProfileIds).toBeUndefined();
      expect(store.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
      const profiles = store.profiles;
      expect(profiles["openai:manual"]).toMatchObject({
        type: "token",
        provider: "openai",
        token: "bearer-token",
      });
      expect(profiles["anthropic:key"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant",
      });
    }, true));

  it("keeps copied openai oauth profiles inline", () =>
    withProfileState(({ agentDirFor }) => {
      const mainAgentDir = agentDirFor("main");
      const copiedAgentDir = agentDirFor("copied");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(copiedAgentDir, { recursive: true });
      const originalProfileId = "openai:default";
      const copiedProfileId = "openai:copied";
      saveAuthProfileStore(
        profileStore(originalProfileId, {
          type: "oauth",
          provider: "openai",
          access: "copy-access-token",
          refresh: "copy-refresh-token",
          expires: Date.now() + 60 * 60 * 1000,
          copyToAgents: true,
        }),
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const originalCredential = loadLocal(mainAgentDir).profiles[originalProfileId];
      expect(originalCredential?.type).toBe("oauth");
      if (!originalCredential || originalCredential.type !== "oauth") {
        throw new Error("expected original oauth credential");
      }
      saveAuthProfileStore(profileStore(copiedProfileId, originalCredential), copiedAgentDir, {
        filterExternalAuthProfiles: false,
      });

      saveAuthProfileStore(makeStore({}), mainAgentDir, { filterExternalAuthProfiles: false });

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(loadLocal(copiedAgentDir).profiles[copiedProfileId], {
        provider: "openai",
        access: "copy-access-token",
        refresh: "copy-refresh-token",
      });
      expect(loadPersisted(copiedAgentDir)?.profiles[copiedProfileId]).toMatchObject({
        access: "copy-access-token",
        refresh: "copy-refresh-token",
      });
    }));

  it.each(["existing", "config-only", "implicit"] as const)(
    "promotes relogin with %s provider ordering",
    async (mode) => {
      await withProfileState(async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        const newId = mode === "existing" ? "openai:bunsthedev@gmail.com" : "openai:new-login";
        const oldId = mode === "existing" ? "openai:val@viewdue.ai" : "openai:old-login";
        const configId = "openai:aws-sdk";
        const profiles = {
          [newId]: oauth("new-access", "new-refresh", Date.now() + 60 * 60 * 1000),
        };
        if (mode !== "implicit") {
          const prefix = mode === "existing" ? "stale" : "old";
          profiles[oldId] = oauth(
            `${prefix}-access`,
            `${prefix}-refresh`,
            Date.now() + 30 * 60 * 1000,
          );
        }
        saveProfiles(profiles, agentDir, mode === "existing" ? { order: { openai: [oldId] } } : {});
        const updated = await promoteAuthProfileInOrder({
          agentDir,
          provider: "openai",
          profileId: newId,
          ...(mode !== "implicit" ? { createIfMissing: true } : {}),
          ...(mode === "config-only" ? { createFromOrder: [oldId, configId] } : {}),
        });
        const expected =
          mode === "implicit"
            ? undefined
            : mode === "config-only"
              ? [newId, oldId, configId]
              : [newId, oldId];
        expect(updated).toMatchObject({ ok: true });
        expect(updated.ok && updated.value.order?.openai).toEqual(expected);
        expect(loadRuntime(agentDir).order?.openai).toEqual(expected);
        if (mode === "config-only") {
          saveAuthProfileStore(loadRuntime(agentDir), agentDir);
          expect(loadRuntime(agentDir).order?.openai).toEqual(expected);
        }
      });
    },
  );

  it.each([true, false])(
    "clears lastGood only for the failed profile (matching=%s)",
    async (matching) => {
      await withProfileState(async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        const storedId = matching ? "openai:default" : "openai:user@example.test";
        const prefix = matching ? "stale" : "good";
        saveProfile(
          storedId,
          oauth(
            `${prefix}-access-token`,
            `${prefix}-refresh-token`,
            Date.now() + (matching ? -60_000 : 60_000),
          ),
          agentDir,
          { lastGood: { openai: storedId } },
        );
        await clearLastGoodProfileWithLock({
          agentDir,
          provider: "openai",
          profileId: "openai:default",
        });
        expect(loadRuntime(agentDir).lastGood).toEqual(matching ? undefined : { openai: storedId });
      });
    },
  );

  it("clears cooldown classification and retry backoff after a successful profile use", () =>
    withProfileState(async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai:default";
      saveProfile(profileId, apiKey("openai", "sk-test"), agentDir, {
        usageStats: {
          [profileId]: {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
            cooldownClassification: "wham_token_expired",
            errorCount: 12,
            failureCounts: { rate_limit: 12 },
          },
        },
      });
      const store = loadRuntime(agentDir);

      await markAuthProfileSuccess({ store, provider: "openai", profileId, agentDir });

      expect(store.usageStats?.[profileId]).toMatchObject({ errorCount: 0 });
      expect(store.usageStats?.[profileId]?.failureCounts).toBeUndefined();
      expect(store.usageStats?.[profileId]?.cooldownUntil).toBeUndefined();
      const persistedStats = loadPersisted(agentDir)?.usageStats?.[profileId];
      expect(persistedStats).toMatchObject({ errorCount: 0 });
      expect(persistedStats).not.toHaveProperty("failureCounts");
      expect(persistedStats).not.toHaveProperty("cooldownUntil");
      expect(persistedStats).not.toHaveProperty("cooldownClassification");
    }));

  it.each([
    { scope: "main", selected: false },
    { scope: "main", selected: true },
    { scope: "secondary", selected: false },
    { scope: "shared", selected: false },
  ] as const)(
    "clears only the $scope credential owners before replacing an expired login (selected=$selected)",
    async ({ scope, selected }) => {
      await withProfileState(async ({ agentDirFor }) => {
        const mainAgentDir = agentDirFor("main");
        const secondaryAgentDir = agentDirFor("secondary");
        const profileId = "openai:default";
        const expired = {
          type: "token" as const,
          provider: "openai",
          token: "synthetic-expired",
          expires: 1,
        };
        const retainedId = "openai:retained";
        const unrelated = { type: "api_key" as const, provider: "other", key: "synthetic-other" };
        await upsertAuthProfileWithLock({ profileId, credential: expired });
        await upsertAuthProfileWithLock({ profileId: retainedId, credential: expired });
        await upsertAuthProfileWithLock({ profileId: "other:default", credential: unrelated });
        for (const agentDir of [mainAgentDir, secondaryAgentDir]) {
          saveProfiles(
            { [profileId]: expired, [retainedId]: expired, "other:default": unrelated },
            agentDir,
            {
              order: { openai: [profileId, retainedId] },
              lastGood: { openai: profileId },
              usageStats: { [profileId]: { disabledUntil: Date.now() + 60_000 } },
            },
          );
        }
        const selectedDir = scope === "shared" ? undefined : agentDirFor(scope);

        expect(
          await removeProviderAuthProfilesWithLock({
            provider: "openai",
            agentDir: selectedDir,
            ...(selected ? { profileIds: [profileId] } : {}),
          }),
        ).not.toBeNull();

        for (const [owner, removed] of [
          [undefined, scope !== "secondary"],
          [mainAgentDir, scope === "main"],
          [secondaryAgentDir, scope === "secondary"],
        ] as const) {
          const stored = loadPersisted(owner);
          expect(stored?.profiles[profileId]).toEqual(removed ? undefined : expired);
          expect(stored?.profiles[retainedId]).toEqual(removed && !selected ? undefined : expired);
          expect(stored?.profiles["other:default"]).toEqual(unrelated);
          if (removed) {
            expect(stored?.order?.openai).toEqual(selected && owner ? [retainedId] : undefined);
            expect(stored?.lastGood?.openai).toBeUndefined();
            expect(stored?.usageStats?.[profileId]).toBeUndefined();
          }
        }
        const fresh = { ...expired, token: "synthetic-fresh", expires: Date.now() + 60_000 };
        await persistAuthProfileBatch({
          agentDir: selectedDir,
          profiles: [{ profileId, credential: fresh }],
          resetFailureState: true,
          allowOAuthGenerationReplacement: true,
        });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        clearRuntimeAuthProfileStoreSnapshots();
        expect(loadRuntime(selectedDir).profiles[profileId]).toEqual(fresh);
      });
    },
  );

  it("narrows provider removal to selected profiles", () =>
    withProfileState(async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const initialStore: RuntimeAuthProfileStore = makeStore(
        {
          "openrouter:oauth": oauth("oauth-access", "oauth-refresh", undefined, "openrouter"),
          "openrouter:api-key": apiKey("openrouter", "api-key"),
        },
        {
          order: { openrouter: ["openrouter:oauth", "openrouter:api-key"] },
          lastGood: { openrouter: "openrouter:oauth" },
          usageStats: {
            "openrouter:oauth": { lastUsed: 1 },
            "openrouter:api-key": { lastUsed: 2 },
          },
          runtimePersistedProfileIds: ["openrouter:oauth", "openrouter:api-key"],
          runtimeLocalProfileIds: ["openrouter:oauth", "openrouter:api-key"],
          runtimeExternalProfileIds: ["openrouter:oauth", "openrouter:api-key"],
        },
      );
      saveAuthProfileStore(initialStore, agentDir);

      const removedStore: RuntimeAuthProfileStore | null = await removeProviderAuthProfilesWithLock(
        { agentDir, provider: "openrouter", profileIds: ["openrouter:oauth"] },
      );

      expect(loadRuntime(agentDir)).toMatchObject({
        profiles: { "openrouter:api-key": expect.any(Object) },
        order: { openrouter: ["openrouter:api-key"] },
        usageStats: { "openrouter:api-key": { lastUsed: 2 } },
      });
      expect(loadRuntime(agentDir).profiles["openrouter:oauth"]).toBeUndefined();
      expect(loadRuntime(agentDir).lastGood).toBeUndefined();
      expect(removedStore?.runtimePersistedProfileIds ?? []).not.toContain("openrouter:oauth");
      expect(removedStore?.runtimeLocalProfileIds ?? []).not.toContain("openrouter:oauth");
      expect(removedStore?.runtimeExternalProfileIds ?? []).not.toContain("openrouter:oauth");
    }));

  it("does not materialize credentials while force-clearing a fresh main store", () =>
    withProfileState(async ({ agentDir }) => {
      await removeProviderAuthProfilesWithLock({ provider: "openai", agentDir });
      expect(loadPersisted(agentDir)).toBeNull();

      const credential = { type: "token" as const, provider: "openai", token: "synthetic-fresh" };
      await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId: "openai:default", credential }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      expect(loadPersisted()?.profiles["openai:default"]).toEqual(credential);
      expect(loadPersisted(agentDir)).toBeNull();
    }));

  it("does not rewrite the store when selected profiles are absent", () =>
    withProfileState(async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const initialStore: AuthProfileStore = profileStore(
        "openrouter:api-key",
        apiKey("openrouter", "api-key"),
      );
      saveAuthProfileStore(initialStore, agentDir);
      publishSnapshots([{ agentDir, store: loadRuntime(agentDir) }]);
      const credentialRevision =
        getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision;
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision;

      await removeProviderAuthProfilesWithLock({
        agentDir,
        provider: "openrouter",
        profileIds: ["openrouter:missing"],
      });

      expect(loadPersisted(agentDir)).toEqual(initialStore);
      expect(getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision).toBe(
        credentialRevision,
      );
      expect(getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision).toBe(stateRevision);
    }));

  it.each([
    { scope: "provider", replaceDuringCleanup: false },
    { scope: "provider", replaceDuringCleanup: true },
  ] as const)(
    "removes a legacy-main $scope once after config cleanup (replacement=$replaceDuringCleanup)",
    async ({ scope, replaceDuringCleanup }) => {
      await withProfileState(async ({ agentDir }) => {
        const profileId = "openai:default";
        const original = {
          type: "token" as const,
          provider: "openai",
          token: "synthetic-original",
        };
        const replacement = { ...original, token: "synthetic-replacement" };
        const unrelated = apiKey("other", "synthetic-other");
        const store = makeStore({ [profileId]: original, "other:default": unrelated });
        saveAuthProfileStore(store, agentDir);
        expect((await reloadSharedAuthStoreOwnership()).location).toBe("legacy-main");
        publishSnapshots([
          {
            agentDir,
            store: { ...store, profiles: { ...store.profiles, [profileId]: replacement } },
          },
        ]);
        const beforeRemove = vi.fn(async () => {
          expect(loadPersisted()?.profiles[profileId]).toEqual(original);
          if (replaceDuringCleanup) {
            saveAuthProfileStore(
              { ...store, profiles: { ...store.profiles, [profileId]: replacement } },
              agentDir,
            );
          }
        });
        const onIncomplete = vi.fn(async () => {});

        const removed = await removeAuthProfilesAcrossOwnerStores({
          agentDir,
          profileIds: [profileId],
          ...(scope === "provider" ? { provider: "openai" } : {}),
          beforeRemove,
          onIncomplete,
        });

        expect(removed).toBe(!replaceDuringCleanup);
        expect(beforeRemove).toHaveBeenCalledExactlyOnceWith([profileId], expect.any(Array));
        for (const owner of [agentDir, undefined]) {
          const persisted = loadPersisted(owner);
          expect(persisted?.profiles[profileId]).toEqual(
            replaceDuringCleanup ? replacement : undefined,
          );
          expect(persisted?.profiles["other:default"]).toEqual(unrelated);
        }
        if (replaceDuringCleanup) {
          expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(
            new Map([[profileId, replacement]]),
            expect.any(Array),
          );
        } else {
          expect(onIncomplete).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("removes an inherited profile from the owning main store too", () =>
    withProfileState(async ({ agentDirFor }) => {
      const mainAgentDir = agentDirFor("main");
      const customAgentDir = agentDirFor("custom");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(customAgentDir, { recursive: true });
      const credential = oauth("inherited-access", "inherited-refresh");
      saveProfile("openai:shared", credential, mainAgentDir);
      saveProfile("openai:shared", credential, customAgentDir);

      const removed = await removeAuthProfilesAcrossOwnerStores({
        agentDir: customAgentDir,
        profileIds: ["openai:shared"],
      });

      expect(removed).toBe(true);
      expect(loadRuntime(customAgentDir).profiles["openai:shared"]).toBeUndefined();
      expect(loadRuntime(mainAgentDir).profiles["openai:shared"]).toBeUndefined();
    }));

  it("retries removal when the OAuth generation changes while waiting for its lock", () =>
    withProfileState(async ({ agentDirFor }) => {
      const mainAgentDir = agentDirFor("main");
      const peerAgentDir = agentDirFor("peer");
      const profileId = "openai:default";
      const original = oauth("original-access", "original-refresh");
      const replacement = {
        ...original,
        access: "replacement-access",
        refresh: "replacement-refresh",
      };
      saveProfile(profileId, original, mainAgentDir);
      saveProfile(profileId, original, peerAgentDir);

      const locked = createDeferredCore();
      const releaseLock = createDeferredCore();
      const blocker = withOAuthProfileLock({ profileId, provider: "openai" }, async () => {
        locked.resolve();
        await releaseLock.promise;
      });
      await locked.promise;

      const removing = removeAuthProfilesAcrossOwnerStores({
        agentDir: mainAgentDir,
        profileIds: [profileId],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      saveProfile(profileId, replacement, mainAgentDir);
      saveProfile(profileId, replacement, peerAgentDir);
      releaseLock.resolve();
      await blocker;

      await expect(removing).resolves.toBe(true);
      expect(loadPersisted(mainAgentDir)?.profiles[profileId]).toBeUndefined();
      expect(loadPersisted(peerAgentDir)?.profiles[profileId]).toBeUndefined();
    }));
});

describe("setAuthProfileOrder", () => {
  it("canonicalizes every alias-equivalent provider state mutation", () =>
    withProfileState(async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const primary = "gmi:primary";
      const secondary = "gmi:secondary";
      const profiles = {
        [primary]: { type: "api_key" as const, provider: "gmi", key: "primary" },
        [secondary]: { type: "api_key" as const, provider: "gmi", key: "secondary" },
        "openai:other": { type: "api_key" as const, provider: "openai", key: "other" },
      };
      const seeded = (): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles,
        order: { "gmi-cloud": [primary], openai: ["openai:other"], gmicloud: [secondary] },
        lastGood: { gmicloud: secondary, openai: "openai:other", "gmi-cloud": primary },
      });
      const reset = (order?: AuthProfileStore["order"]) => {
        const store = seeded();
        saveAuthProfileStore(
          order ? { ...store, order: { ...store.order, ...order } } : store,
          agentDir,
        );
        clearRuntimeAuthProfileStoreSnapshots();
      };
      reset();
      await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: [secondary] });
      expect(loadPersisted(agentDir)?.order).toEqual({
        openai: ["openai:other"],
        gmi: [secondary],
      });
      reset({ gmi: [primary] });
      await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: null });
      expect(loadPersisted(agentDir)?.order).toEqual({ openai: ["openai:other"] });

      reset({ "gmi-cloud": [secondary, primary] });
      await promoteAuthProfileInOrder({ agentDir, provider: "gmi-cloud", profileId: secondary });
      expect(loadPersisted(agentDir)?.order).toEqual({
        openai: ["openai:other"],
        gmi: [secondary, primary],
      });

      reset();
      await clearLastGoodProfileWithLock({ agentDir, provider: "gmi-cloud", profileId: secondary });
      expect(loadPersisted(agentDir)?.lastGood).toEqual({ openai: "openai:other" });

      reset();
      const runtimeStore = loadRuntime(agentDir);
      await markAuthProfileSuccess({
        agentDir,
        profileId: secondary,
        provider: "gmi-cloud",
        store: runtimeStore,
      });
      expect(loadPersisted(agentDir)?.lastGood).toEqual({ openai: "openai:other", gmi: secondary });

      reset();
      await removeProviderAuthProfilesWithLock({ agentDir, provider: "gmi-cloud" });
      expect(loadPersisted(agentDir)).toMatchObject({
        profiles: { "openai:other": expect.any(Object) },
        order: { openai: ["openai:other"] },
        lastGood: { openai: "openai:other" },
      });
    }));

  it("preserves inherited main OAuth profile IDs in a secondary agent order without copying credentials", () =>
    withProfileState(async ({ agentDirFor }) => {
      const mainAgentDir = agentDirFor("main");
      const customAgentDir = agentDirFor("custom");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(customAgentDir, { recursive: true });
      const mainStore = (): AuthProfileStore =>
        makeStore(
          {
            "openai:profile-a": oauth("access-a", "refresh-a"),
            "openai:profile-b": oauth("access-b", "refresh-b"),
          },
          { order: { openai: ["openai:profile-a"] } },
        );
      saveAuthProfileStore(mainStore());

      // Regression #119233: local saves must preserve inherited order references.
      const updated = await setAuthProfileOrder({
        agentDir: customAgentDir,
        provider: "openai",
        order: ["openai:profile-b"],
      });

      expect(updated?.order?.openai).toEqual(["openai:profile-b"]);
      expect(loadPersisted(customAgentDir)?.order?.openai).toEqual(["openai:profile-b"]);
      expect(loadRuntime(customAgentDir).order?.openai).toEqual(["openai:profile-b"]);
      const persistedCustom = loadPersisted(customAgentDir);
      expect(persistedCustom?.profiles["openai:profile-b"]).toBeUndefined();
      expect(persistedCustom?.profiles["openai:profile-a"]).toBeUndefined();
    }, true));

  it("clears a provider order without preserving any profile IDs", () =>
    withProfileState(async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      saveProfile("openai:local", apiKey("openai", "sk-local"), undefined, {
        order: { openai: ["openai:local"] },
      });

      const updated = await setAuthProfileOrder({ agentDir, provider: "openai", order: null });

      expect(updated?.order?.openai ?? null).toBeNull();
      expect(loadPersisted(agentDir)?.order?.openai ?? null).toBeNull();
    }, true));
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
