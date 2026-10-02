import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import * as modelPlans from "../models-config.plan.js";
import * as catalogCredentials from "../plugin-model-catalog-credentials.js";
import * as catalogs from "../plugin-model-catalog.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { withAuthProfileTestState } from "./profile-mutations.test-support.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import * as storeRuntime from "./store-runtime.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";

afterEach(() => clearRuntimeAuthProfileStoreSnapshots());

describe("auth profile catalog credential removal", () => {
  it.each([
    { window: "before-delete", credentialChange: "unchanged" },
    { window: "after-delete", credentialChange: "unchanged" },
    { window: "after-delete", credentialChange: "rotated" },
    { window: "after-delete", credentialChange: "added" },
  ] as const)(
    "does not retain a held refresh credential published $window ($credentialChange)",
    async ({ window, credentialChange }) => {
      await withAuthProfileTestState("openclaw-held-catalog-", async ({ agentDir }) => {
        const initialKey = "held-refresh-secret";
        const key = credentialChange === "unchanged" ? initialKey : "held-refresh-replacement";
        const independentKey = "never-canonical-catalog-key";
        const independentHeader = "never-canonical-catalog-header";
        const survivor = createApiKeyCredential("fixture", "held-refresh-surviving-secret");
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles:
              credentialChange === "added"
                ? { survivor }
                : { survivor, selected: { type: "api_key", provider: "fixture", key: initialKey } },
          },
          agentDir,
        );
        const planned = createDeferredCore();
        const release = createDeferredCore();
        const planner = vi
          .spyOn(modelPlans, "planOpenClawModelsJson")
          .mockImplementationOnce(async () => {
            if (credentialChange !== "unchanged") {
              saveAuthProfileStore(
                {
                  version: AUTH_STORE_VERSION,
                  profiles: { survivor, selected: { type: "api_key", provider: "fixture", key } },
                },
                agentDir,
              );
            }
            const credential =
              loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles.selected;
            if (credential?.type !== "api_key") {
              throw new Error("expected selected API-key profile during catalog planning");
            }
            expect(credential.key).toBe(key);
            const contents = JSON.stringify({
              generatedBy: "openclaw-plugin-model-catalog-v1",
              providers: {
                fixture: {
                  api: "openai-completions",
                  apiKey: credential.key,
                  headers: { Authorization: `Bearer ${credential.key}` },
                  models: [
                    {
                      id: "retained-inventory",
                      apiKey: independentKey,
                      headers: { "X-Independent-Auth": independentHeader },
                    },
                    {
                      id: "surviving-inventory",
                      apiKey: survivor.key,
                      headers: { Authorization: `Bearer ${survivor.key}` },
                    },
                  ],
                },
              },
            });
            planned.resolve();
            await release.promise;
            return {
              action: "write",
              contents: '{"providers":{}}\n',
              pluginCatalogWrites: {
                [catalogs.encodePluginModelCatalogRelativePath("fixture")]: contents,
              },
            };
          });
        const refresh = ensureOpenClawModelsJson({}, agentDir);
        await Promise.race([planned.promise, refresh]);
        const scrub = catalogCredentials.removePersistedPluginModelCatalogCredentials;
        const publishHeldRefresh = async () => {
          release.resolve();
          await refresh;
          const persisted =
            catalogs.loadPersistedPluginModelCatalogsReadOnly(agentDir)[0]?.contents;
          if (window === "before-delete") {
            expect(persisted).toContain(key);
          } else {
            expect(persisted).not.toContain(key);
            expect(persisted).toContain("retained-inventory");
          }
        };
        const cleanup = vi
          .spyOn(catalogCredentials, "removePersistedPluginModelCatalogCredentials")
          .mockImplementation(async (params) => {
            await scrub(params);
            if (window === "after-delete") {
              await publishHeldRefresh();
            }
          });
        try {
          expect(
            await removeAuthProfilesAcrossOwnerStores({
              agentDir,
              profileIds: ["selected"],
              beforeRemove: window === "before-delete" ? publishHeldRefresh : undefined,
            }),
          ).toBe(true);
          expect(cleanup.mock.calls.length).toBe(1);
          expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual({ survivor });
          const persisted =
            catalogs.loadPersistedPluginModelCatalogsReadOnly(agentDir)[0]?.contents;
          expect(persisted).not.toContain(key);
          expect(persisted).toContain("retained-inventory");
          expect(persisted).toContain(independentKey);
          expect(persisted).toContain(independentHeader);
          expect(JSON.parse(persisted ?? "null").providers.fixture.models).toContainEqual({
            id: "surviving-inventory",
            apiKey: survivor.key,
            headers: { Authorization: `Bearer ${survivor.key}` },
          });
        } finally {
          release.resolve();
          await refresh;
          cleanup.mockRestore();
          planner.mockRestore();
        }
      });
    },
  );

  it.each(["contention", "failure"] as const)(
    "scrubs cached credentials after partial removal ends with %s",
    async (exit) => {
      await withAuthProfileTestState("openclaw-auth-partial-scrub-", async ({ agentDirFor }) => {
        const main = agentDirFor("main");
        const child = agentDirFor("child");
        const profileId = "openai:shared";
        const credential = {
          type: "oauth" as const,
          provider: "openai",
          access: "synthetic-partial-access",
          refresh: "synthetic-partial-refresh",
          expires: Date.now() + 60_000,
        };
        for (const agentDir of [main, child]) {
          saveAuthProfileStore(
            { version: AUTH_STORE_VERSION, profiles: { [profileId]: credential } },
            agentDir,
          );
        }
        await catalogs.replacePersistedPluginModelCatalogs({
          agentDir: child,
          pluginCatalogWrites: {
            [catalogs.encodePluginModelCatalogRelativePath("fixture")]: JSON.stringify({
              generatedBy: "openclaw-plugin-model-catalog-v1",
              providers: {
                fixture: {
                  api: "openai-completions",
                  apiKey: credential.access,
                  models: [{ id: "retained" }],
                },
              },
            }),
          },
        });
        const update = storeRuntime.updateAuthProfileStoreWithLock;
        const updating = vi
          .spyOn(storeRuntime, "updateAuthProfileStoreWithLock")
          .mockImplementation(async (params) => {
            if (params.agentDir !== child) {
              expect(loadPersistedAuthProfileStore(child)?.profiles[profileId]).toBeUndefined();
              if (exit === "failure") {
                throw new Error("synthetic second-owner failure");
              }
              return null;
            }
            return update(params);
          });
        try {
          const removing = removeAuthProfilesAcrossOwnerStores({
            agentDir: child,
            profileIds: [profileId],
          });
          if (exit === "failure") {
            await expect(removing).rejects.toThrow("synthetic second-owner failure");
          } else {
            await expect(removing).resolves.toBe(false);
          }
          expect(loadPersistedAuthProfileStore(main)?.profiles[profileId]).toEqual(credential);
          expect(loadPersistedAuthProfileStore(child)?.profiles[profileId]).toBeUndefined();
          const persisted = catalogs.loadPersistedPluginModelCatalogsReadOnly(child)[0]?.contents;
          expect(persisted).toContain("retained");
          expect(persisted).not.toContain(credential.access);
        } finally {
          updating.mockRestore();
        }
      });
    },
  );
});
