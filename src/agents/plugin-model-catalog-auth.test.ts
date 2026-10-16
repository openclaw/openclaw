import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import * as machineState from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as persistedAuth from "./auth-profiles/persisted.js";
import { writeAuthProfileJsonCell } from "./auth-profiles/sqlite-json-write.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { capturePluginModelCatalogAuth } from "./plugin-model-catalog-auth.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

const sharedStore = {
  version: 1,
  profiles: {
    "catalog-fixture:shared": {
      type: "oauth",
      provider: "catalog-fixture",
      access: "shared-access-not-real",
      refresh: "shared-refresh-not-real",
      expires: 0,
    },
  },
} satisfies AuthProfileStore;

const localStore = {
  version: 1,
  profiles: {
    "catalog-fixture:local": {
      type: "api_key",
      provider: "catalog-fixture",
      key: "local-key-not-real",
    },
  },
} satisfies AuthProfileStore;

async function seedAuthRows(state: OpenClawTestState, local: unknown = localStore) {
  const shared = openOpenClawStateDatabase({ env: state.env });
  // Model a preexisting installation without warming the process's shared-owner cache.
  const insert = shared.db.prepare(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  );
  insert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }), 1);
  insert.run("authProfiles.store", JSON.stringify(sharedStore), 1);
  const agentDir = state.agentDir("helper");
  const localPath = resolveAuthProfileDatabasePath(agentDir);
  const agent = openOpenClawAgentDatabase({
    agentId: "helper",
    path: localPath,
    env: state.env,
  });
  writeAuthProfileJsonCell(agent.db, "store", "agent", local);
  await closeOpenClawAgentDatabasesAsync(state.root);
  await closeOpenClawStateDatabaseByPathAsync(shared.path);
  return { agentDir, localPath, sharedPath: shared.path };
}

describe("plugin model catalog auth capture", () => {
  it("captures cold shared and local credentials from the explicit root through workers", async () => {
    await withOpenClawTestState({ label: "catalog-auth-ambient" }, async () => {
      await withOpenClawTestState(
        { label: "catalog-auth-explicit", applyEnv: false },
        async (state) => {
          const { agentDir, localPath, sharedPath } = await seedAuthRows(state);
          const syncAuth = vi
            .spyOn(persistedAuth, "loadPersistedAuthProfileStoreAtDatabasePath")
            .mockImplementation(() => {
              throw new Error("Catalog auth must not read canonical credentials on the parent");
            });
          const syncOwnership = vi
            .spyOn(machineState, "readConfigMachineState")
            .mockImplementation(() => {
              throw new Error("Catalog auth must not discover shared ownership on the parent");
            });
          try {
            // These spies belong to the parent; the real worker isolates read the seeded rows.
            await expect(capturePluginModelCatalogAuth(agentDir, state.env)).resolves.toEqual([
              {
                databasePath: sharedPath,
                kind: "shared-state",
                credentials: {
                  "catalog-fixture:shared": ["shared-access-not-real", "shared-refresh-not-real"],
                },
              },
              {
                databasePath: localPath,
                kind: "agent",
                credentials: { "catalog-fixture:local": ["local-key-not-real"] },
              },
            ]);
          } finally {
            syncOwnership.mockRestore();
            syncAuth.mockRestore();
          }
        },
      );
    });
  });

  it("refuses an unreadable local store instead of publishing a partial auth snapshot", async () => {
    await withOpenClawTestState({ label: "catalog-auth-unreadable" }, async (state) => {
      const { agentDir, localPath } = await seedAuthRows(state, {
        version: 1,
        profiles: "invalid-profile-map",
      });

      await expect(capturePluginModelCatalogAuth(agentDir, state.env)).rejects.toMatchObject({
        code: "AUTH_PROFILE_STORE_UNREADABLE",
        action: "openclaw doctor --fix",
        databasePath: localPath,
      });
    });
  });
  it("returns committed rows when credential stripping skips invalid planned catalogs", async () => {
    await withOpenClawTestState({ label: "catalog-auth-receipt" }, async (state) => {
      const agentDir = state.agentDir("helper");
      const catalogContents = (provider: string, apiKey?: string) =>
        JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            [provider]: {
              api: "openai-completions",
              baseUrl: `https://${provider}.example/v1`,
              ...(apiKey ? { apiKey } : {}),
              models: [{ id: `${provider}-model`, name: `${provider} model` }],
            },
          },
        });
      const keep = catalogContents("keep");
      await replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("keep")]: keep,
          [encodePluginModelCatalogRelativePath("null-row")]: catalogContents("null-row"),
          [encodePluginModelCatalogRelativePath("stale")]: catalogContents("stale"),
        },
      });
      await closeOpenClawAgentDatabasesAsync();
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      try {
        database
          .prepare("UPDATE cache_entries SET value_json = NULL WHERE scope = ? AND key = ?")
          .run("plugin-model-catalog-v1", "null-row");
      } finally {
        database.close();
      }

      const publication = await replacePersistedPluginModelCatalogs({
        agentDir,
        authSnapshot: [
          {
            databasePath: resolveAuthProfileDatabasePath(agentDir),
            kind: "agent",
            credentials: { removed: ["synthetic-removed"] },
          },
        ],
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("keep")]: "{",
          [encodePluginModelCatalogRelativePath("absent")]: "{",
          [encodePluginModelCatalogRelativePath("null-row")]: "{",
          [encodePluginModelCatalogRelativePath("next")]: catalogContents(
            "next",
            "synthetic-removed",
          ),
        },
      });
      const expected = [
        { pluginId: "keep", contents: keep },
        { pluginId: "next", contents: catalogContents("next") },
      ];
      expect(publication).toEqual({ changed: true, catalogs: expected });
      expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual(expected);
      const snapshot = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir), {
        readOnly: true,
      });
      try {
        expect(
          snapshot
            .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
            .get("plugin-model-catalog-v1", "null-row"),
        ).toEqual({ value_json: null });
      } finally {
        snapshot.close();
      }
    });
  });
});
