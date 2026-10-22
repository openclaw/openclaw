import { afterEach, expect, it, vi } from "vitest";
import { inspectDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../../state/user-model-account-authority.js";
import { resolveCliExecutionAuthProfileId } from "../cli-execution-auth.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import * as modelPlans from "../models-config.plan.js";
import * as catalogCredentials from "../plugin-model-catalog-credentials.js";
import * as catalogs from "../plugin-model-catalog.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  createApiKeyCredential as apiKey,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore as loadPersisted } from "./persisted.js";
import { withAuthProfileTestState as withState } from "./profile-mutations.test-support.js";
import { removeAuthProfilesAcrossOwnerStores as removeProfiles } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStateRaw as inspectState,
  inspectPersistedAuthProfileStoreRaw as inspectStore,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
} from "./sqlite.js";
import {
  loadAuthProfileStoreForRuntimeAsync as loadRuntimeAsync,
  loadAuthProfileStoreWithoutExternalProfiles as loadLocal,
  saveAuthProfileStore,
} from "./store-runtime.js";
import * as storeUpdate from "./store-update.js";
import type { AuthProfileStore } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

function resolveCliProfile(agentDir: string, profileId: string) {
  return resolveCliExecutionAuthProfileId({
    cliExecutionProvider: "claude-cli",
    authProfileProvider: "claude-cli",
    config: {},
    agentDir,
    selected: { authProfileId: profileId, authProfileIdSource: "user" },
  });
}

function saveProfiles(agentDir: string, profiles: AuthProfileStore["profiles"]) {
  saveAuthProfileStore({ version: AUTH_STORE_VERSION, profiles }, agentDir);
}

function catalogWrites(
  key: string | undefined,
  models: Array<{ id: string; apiKey?: string; headers?: Record<string, string> }>,
  headers?: Record<string, string>,
) {
  return {
    [catalogs.encodePluginModelCatalogRelativePath("fixture")]: JSON.stringify({
      generatedBy: "openclaw-plugin-model-catalog-v1",
      providers: { fixture: { api: "openai-completions", apiKey: key, headers, models } },
    }),
  };
}

const readCatalog = (agentDir: string) =>
  catalogs.loadPersistedPluginModelCatalogsReadOnly(agentDir)[0]?.contents;
const spyCleanup = () =>
  vi.spyOn(catalogCredentials, "removePersistedPluginModelCatalogCredentials");

it.each([
  { window: "before-delete", credentialChange: "unchanged" },
  { window: "after-delete", credentialChange: "unchanged" },
  { window: "after-delete", credentialChange: "rotated" },
  { window: "after-delete", credentialChange: "added" },
] as const)(
  "does not retain a held refresh credential published $window ($credentialChange)",
  ({ window, credentialChange }) =>
    withState("openclaw-held-catalog-", async ({ agentDir }) => {
      const initialKey = "held-refresh-secret";
      const key = credentialChange === "unchanged" ? initialKey : "held-refresh-replacement";
      const independentKey = "never-canonical-catalog-key";
      const independentHeader = "never-canonical-catalog-header";
      const survivor = apiKey("fixture", "held-refresh-surviving-secret");
      const survivingModel = {
        id: "surviving-inventory",
        apiKey: survivor.key,
        headers: { Authorization: `Bearer ${survivor.key}` },
      };
      saveProfiles(
        agentDir,
        credentialChange === "added"
          ? { survivor }
          : { survivor, selected: apiKey("fixture", initialKey) },
      );
      const planned = createDeferredCore();
      const release = createDeferredCore();
      vi.spyOn(modelPlans, "planOpenClawModelsJson").mockImplementationOnce(async () => {
        if (credentialChange !== "unchanged") {
          saveProfiles(agentDir, {
            survivor,
            selected: apiKey("fixture", key),
          });
        }
        const credential = loadLocal(agentDir).profiles.selected;
        if (credential?.type !== "api_key") {
          throw new Error("expected selected API-key profile during catalog planning");
        }
        expect(credential.key).toBe(key);
        const pluginCatalogWrites = catalogWrites(
          credential.key,
          [
            {
              id: "retained-inventory",
              apiKey: independentKey,
              headers: { "X-Independent-Auth": independentHeader },
            },
            survivingModel,
          ],
          { Authorization: `Bearer ${credential.key}` },
        );
        planned.resolve();
        await release.promise;
        return { action: "write", contents: '{"providers":{}}\n', pluginCatalogWrites };
      });
      const refresh = ensureOpenClawModelsJson({}, agentDir);
      await Promise.race([planned.promise, refresh]);
      const scrub = catalogCredentials.removePersistedPluginModelCatalogCredentials;
      const publishHeldRefresh = async () => {
        release.resolve();
        const result = await refresh;
        const persisted = readCatalog(agentDir);
        expect(result.publishedSource).toMatchObject({
          modelsJsonContents: '{"providers":{}}\n',
          pluginCatalogs: [{ pluginId: "fixture", contents: persisted }],
        });
        if (window === "before-delete") {
          expect(persisted).toContain(key);
        } else {
          expect(persisted).not.toContain(key);
          expect(persisted).toContain("retained-inventory");
        }
      };
      const cleanup = spyCleanup().mockImplementation(async (params) => {
        await scrub(params);
        if (window === "after-delete") {
          await publishHeldRefresh();
        }
      });
      try {
        expect(
          await removeProfiles({
            agentDir,
            profileIds: ["selected"],
            beforeRemove: window === "before-delete" ? publishHeldRefresh : undefined,
          }),
        ).toBe(true);
        expect(cleanup.mock.calls.length).toBe(1);
        expect(loadPersisted(agentDir)?.profiles).toEqual({ survivor });
        const persisted = readCatalog(agentDir);
        expect(persisted).not.toContain(key);
        expect(persisted).toContain("retained-inventory");
        expect(persisted).toContain(independentKey);
        expect(persisted).toContain(independentHeader);
        expect(JSON.parse(persisted ?? "null").providers.fixture.models).toContainEqual(
          survivingModel,
        );
      } finally {
        release.resolve();
        await refresh;
      }
    }),
);

it.each(["contention", "failure"] as const)(
  "scrubs cached credentials after partial removal ends with %s",
  (exit) =>
    withState("openclaw-auth-partial-scrub-", async ({ agentDirFor }) => {
      const main = agentDirFor("main");
      const child = agentDirFor("child");
      const profileId = "openai:shared";
      const credential = createOAuthRefreshCredential();
      for (const agentDir of [main, child]) {
        saveProfiles(agentDir, { [profileId]: credential });
      }
      await catalogs.replacePersistedPluginModelCatalogs({
        agentDir: child,
        pluginCatalogWrites: catalogWrites(credential.access, [{ id: "retained" }]),
      });
      const update = storeUpdate.runAuthProfileStoreUpdate;
      vi.spyOn(storeUpdate, "runAuthProfileStoreUpdate").mockImplementation(async (params) => {
        if (params.agentDir !== child) {
          expect(loadPersisted(child)?.profiles[profileId]).toBeUndefined();
          if (exit === "failure") {
            throw new Error("synthetic second-owner failure");
          }
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        return update(params);
      });
      const removing = removeProfiles({ agentDir: child, profileIds: [profileId] });
      if (exit === "failure") {
        await expect(removing).rejects.toThrow("synthetic second-owner failure");
      } else {
        await expect(removing).resolves.toBe(false);
      }
      expect(loadPersisted(main)?.profiles[profileId]).toEqual(credential);
      expect(loadPersisted(child)?.profiles[profileId]).toBeUndefined();
      const persisted = readCatalog(child);
      expect(persisted).toContain("retained");
      expect(persisted).not.toContain(credential.access);
    }),
);

it("restores an absent credential cell and exact state after catalog cleanup fails", () =>
  withState("openclaw-auth-absent-rollback-", async ({ agentDirFor }) => {
    const agentDir = agentDirFor("state-only");
    const profileId = "fixture:selected";
    const state = {
      version: AUTH_STORE_VERSION,
      order: { fixture: [profileId, "fixture:retained"] },
      lastGood: { fixture: profileId },
      usageStats: { [profileId]: { lastUsed: 1 }, "fixture:retained": { lastUsed: 2 } },
      extensionState: "preserve raw state during compensation",
    };
    writePersistedAuthProfileStateRaw(state, agentDir);
    const absent = { status: "missing", reason: "row" };
    expect(inspectStore(agentDir)).toEqual(absent);
    let removedState: ReturnType<typeof inspectState> | undefined;
    const cleanup = spyCleanup().mockImplementationOnce(async () => {
      removedState = inspectState(agentDir);
      throw new Error("synthetic catalog cleanup failure");
    });

    await expect(removeProfiles({ agentDir, profileIds: [profileId] })).rejects.toThrow(
      "saved credentials were restored",
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(removedState).toMatchObject({
      status: "readable",
      raw: { order: { fixture: ["fixture:retained"] } },
    });
    expect(JSON.stringify(removedState)).not.toContain(profileId);
    expect(inspectStore(agentDir)).toEqual(absent);
    expect(inspectState(agentDir)).toEqual({ status: "readable", raw: state });
  }));

it("revokes a retained credential and the next CLI inference after logout commits", () =>
  withState("openclaw-auth-cli-logout-", async ({ agentDirFor }) => {
    const agentDir = agentDirFor("inference");
    const profileId = "claude-cli:work";
    const credential = apiKey("claude-cli", "synthetic-cli-credential");
    saveProfiles(agentDir, { [profileId]: credential });
    const resolveProfile = () => resolveCliProfile(agentDir, profileId);
    await expect(resolveProfile()).resolves.toBe(profileId);
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    const identity = inspectDatabasePathIdentitySync(databasePath);
    if (!identity) {
      throw new Error("Missing fixture database identity");
    }
    const authority = captureAuthProfileCredentialAuthority(
      captureOpenClawStateWorkerContext(),
      { identity: `${identity.key}:${identity.birthtime ?? ""}`, databasePath },
      profileId,
    );
    expect(authority.readCurrentCredential()).toEqual(credential);

    await expect(removeProfiles({ agentDir, profileIds: [profileId] })).resolves.toBe(true);

    expect(authority.readCurrentCredential()).toBeUndefined();
    await expect(resolveProfile()).rejects.toThrow(
      `No credentials found for profile "${profileId}"`,
    );
  }));

it("preserves newer credentials and selection when failed cleanup compensates logout", () =>
  withState("openclaw-auth-newer-rollback-", async ({ agentDirFor }) => {
    const agentDir = agentDirFor("inference");
    const profileId = "claude-cli:work";
    saveProfiles(agentDir, {
      [profileId]: apiKey("claude-cli", "synthetic-original-credential"),
    });
    const resolveProfile = () => resolveCliProfile(agentDir, profileId);
    await expect(resolveProfile()).resolves.toBe(profileId);
    const newerStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileId]: apiKey("claude-cli", "synthetic-replacement-credential"),
        "claude-cli:unrelated": apiKey("claude-cli", "synthetic-unrelated-key"),
      },
      order: { "claude-cli": ["claude-cli:unrelated", profileId] },
      lastGood: { "claude-cli": "claude-cli:unrelated" },
    };
    let removalObserved = false;
    spyCleanup().mockImplementationOnce(async () => {
      removalObserved = loadPersisted(agentDir)?.profiles[profileId] === undefined;
      saveAuthProfileStore(newerStore, agentDir);
      throw new Error("synthetic catalog cleanup failure");
    });

    await expect(removeProfiles({ agentDir, profileIds: [profileId] })).rejects.toThrow(
      "concurrent auth changes prevented full restoration",
    );
    expect(removalObserved).toBe(true);
    expect(loadPersisted(agentDir)).toEqual(newerStore);
    await expect(
      loadRuntimeAsync(agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
      }),
    ).resolves.toMatchObject(newerStore);
    await expect(resolveProfile()).resolves.toBe(profileId);
  }));
