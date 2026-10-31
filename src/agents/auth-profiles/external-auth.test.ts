import "./external-auth.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../../state/user-model-account-authority.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import {
  createExternalAuthRuntime,
  syncPersistedExternalCliAuthProfiles,
} from "./external-auth.js";
import { isPersistedExternalCliAuthProfile } from "./external-cli-sync.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  registerRuntimeAuthProfileStoreMutationListener,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";
import { runAuthProfileWriteTransaction } from "./sqlite.js";
import { withAgentDirEnv } from "./sqlite.test-support.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import type { OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

const { testing } = await import("./external-auth.test-support.js");
const runPrepared: Parameters<typeof createExternalAuthRuntime>[1] = (_params, run) => run();

const readOptions = { allowKeychainPrompt: false, readOnly: true, syncExternalCli: false };
const minimaxId = "minimax-portal:minimax-cli";
const isExternal = (credential: OAuthCredential, profileId = minimaxId) =>
  isPersistedExternalCliAuthProfile({ profileId, credential });
const readMiniMax = vi.hoisted(() => vi.fn<() => OAuthCredential | null>(() => null));
vi.mock("../cli-credentials.js", () => ({ readMiniMaxCliCredentialsCached: readMiniMax }));
const credential = (overrides: Partial<OAuthCredential> = {}) =>
  createOAuthRefreshCredential({ expires: Date.now() + 1_800_000, ...overrides });

beforeEach(() => {
  prepareSharedAuthStoreOwnershipForNative();
  readMiniMax.mockReset().mockReturnValue(null);
  testing.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});
afterEach(() => {
  testing.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

it.each(["expired", "matching-refresh", "matching-access"])(
  "preserves MiniMax provenance with %s credentials",
  async (kind) => {
    const stored = credential({
      provider: "minimax-portal",
      expires: kind === "expired" ? 1 : Date.now() + 1_800_000,
      ...(kind === "matching-access" ? { authFlow: "device-code" } : {}),
    });
    const imported = credential({
      provider: "minimax-portal",
      access: kind === "matching-access" ? stored.access : "rotated-access",
      refresh: kind === "matching-refresh" ? stored.refresh : "rotated-refresh",
    });
    readMiniMax.mockReturnValue(imported);
    const store = { version: 1, profiles: { [minimaxId]: stored } };
    const synced = syncPersistedExternalCliAuthProfiles(store);
    const expected = kind === "expired" ? imported : stored;
    expect(synced.profiles[minimaxId]).toEqual({
      ...expected,
      ...(kind === "matching-access" ? {} : { authFlow: "external-cli" }),
    });
    const syncedCredential = synced.profiles[minimaxId];
    if (syncedCredential?.type !== "oauth") {
      throw new Error("Expected persisted OAuth credential");
    }
    expect(isExternal(syncedCredential)).toBe(kind !== "matching-access");
    expect(isExternal(credential({ authFlow: "external-cli" }), "openai:default")).toBe(false);
    const overlaid = createExternalAuthRuntime(() => [], runPrepared).overlayExternalAuthProfiles(
      store,
    );
    expect(overlaid.profiles[minimaxId]).toEqual(synced.profiles[minimaxId]);
    if (kind === "expired") {
      await withAgentDirEnv("external-cli-authority-", async (agentDir) => {
        saveAuthProfileStore(store, agentDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });
        const database = runAuthProfileWriteTransaction(agentDir, (owner) => owner);
        const source = readDatabasePathIdentitySync(database.path);
        const authority = captureAuthProfileCredentialAuthority(
          captureOpenClawStateWorkerContext(),
          { identity: `${source.key}:${source.birthtime ?? ""}`, databasePath: database.path },
          minimaxId,
        );
        authority.observe(stored);
        const exec = database.db.exec.bind(database.db);
        using commit = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
          if (sql === "COMMIT") {
            expect(() => authority.readCurrentCredential()).toThrow("authority is unavailable");
          }
          return exec(sql);
        });
        ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
        commit.mockRestore();
        expect(authority.readCurrentCredential()).toEqual({
          ...imported,
          authFlow: "external-cli",
        });
        expect(
          ensureAuthProfileStore(agentDir, { readOnly: true, syncExternalCli: false }).profiles[
            minimaxId
          ],
        ).toEqual(authority.readCurrentCredential());
      });
    }
  },
);

it("keeps plugin ownership over retired CLI slots and forwards active config", () => {
  testing.resetResolveExternalAuthProfilesForTest();
  const config = {
    models: { providers: { openai: { auth: "oauth" as const, baseUrl: "", models: [] } } },
  };
  const pluginCredential = credential();
  const resolver = vi.fn(() => [{ profileId: "openai:default", credential: pluginCredential }]);
  const runtime = createExternalAuthRuntime(resolver, runPrepared);
  const options = { config, externalCliProviderIds: ["openai"] };
  const first = runtime.overlayExternalAuthProfiles({ version: 1, profiles: {} }, options);
  const next = runtime.overlayExternalAuthProfiles(first, options);
  expect(next.profiles["openai:default"]).toEqual(pluginCredential);
  expect(next.runtimeExternalProfileIds).toEqual(["openai:default"]);
  expect(resolver).toHaveBeenLastCalledWith(
    expect.objectContaining({ config, context: expect.objectContaining({ config }) }),
  );
});

it.each([false, true])("retains external account health during a scoped=%s refresh", (scoped) => {
  const agentDir = "/tmp/openclaw-external-owner-health";
  const profileId = "openai:external";
  const external = credential();
  const store: RuntimeAuthProfileStore = {
    version: 1,
    profiles: { [profileId]: external },
    order: { openai: [profileId] },
    lastGood: { openai: profileId },
    usageStats: { [profileId]: { lastUsed: 17, cooldownUntil: 123_456 } },
    runtimeExternalProfileIds: [profileId],
  };
  testing.setResolveExternalAuthProfilesForTest(() => [{ profileId, credential: external }]);
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
  const loaded = ensureAuthProfileStore(agentDir, {
    ...(scoped ? { externalCliProviderIds: ["openai"] } : {}),
    ...readOptions,
  });
  // Scoped lookups publish retained health; ordinary lookups return it to the caller.
  const retained = scoped ? getRuntimeAuthProfileStoreSnapshotCore(agentDir) : loaded;
  const { profiles, order, lastGood, usageStats } = store;
  expect(retained).toMatchObject({ profiles, order, lastGood, usageStats });
  expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats).toEqual(store.usageStats);
});

it.each([undefined, "resolved-key"])(
  "keeps prepared API-key refs during ordinary scoped reads (%s)",
  (key) => {
    const agentDir = "/tmp/openclaw-external-owner-prepared";
    const profileId = key ? "openai:configured" : "openai:default";
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider: "openai",
          key,
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    try {
      const loaded = ensureAuthProfileStore(agentDir, {
        externalCliProviderIds: ["openai"],
        ...readOptions,
      });
      expect(loaded.profiles).toEqual(store.profiles);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles).toEqual(store.profiles);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  },
);
