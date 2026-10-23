import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
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
import { withRestoredMocks } from "../test-utils/vitest-spies.js";
import * as persistedAuth from "./auth-profiles/persisted.js";
import { writeAuthProfileJsonCell } from "./auth-profiles/sqlite-json-write.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { capturePluginModelCatalogAuth } from "./plugin-model-catalog-auth.js";
import {
  encodePluginModelCatalogRelativePath as encode,
  loadPersistedPluginModelCatalogsReadOnly as readCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs as replaceCatalogs,
} from "./plugin-model-catalog.js";

function store(id: string, profile: AuthProfileStore["profiles"][string]): AuthProfileStore {
  return { version: 1, profiles: { [id]: profile } };
}

const sharedStore = store("fixture:shared", {
  type: "oauth",
  provider: "fixture",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: 0,
});
const localStore = store("fixture:local", {
  type: "api_key",
  provider: "fixture",
  key: "synthetic-key",
});

function authOwner(
  databasePath: string,
  credentials: Record<string, string[]>,
  kind: "agent" | "shared-state" = "agent",
) {
  return { databasePath, kind, credentials };
}

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
  const agent = openOpenClawAgentDatabase({ agentId: "helper", path: localPath, env: state.env });
  writeAuthProfileJsonCell(agent.db, "store", "agent", local);
  await closeOpenClawAgentDatabasesAsync(state.root);
  await closeOpenClawStateDatabaseByPathAsync(shared.path);
  return { agentDir, localPath, sharedPath: shared.path };
}

it("captures cold shared and local credentials from the explicit root through workers", () =>
  withOpenClawTestState({ label: "catalog-auth-ambient" }, async () => {
    await withOpenClawTestState(
      { label: "catalog-auth-explicit", applyEnv: false },
      async (state) => {
        const { agentDir, localPath, sharedPath } = await seedAuthRows(state);
        const parentRead = () => {
          throw new Error("Catalog auth must read in workers");
        };
        await withRestoredMocks(
          [
            vi
              .spyOn(persistedAuth, "loadPersistedAuthProfileStoreAtDatabasePath")
              .mockImplementation(parentRead),
            vi.spyOn(machineState, "readConfigMachineState").mockImplementation(parentRead),
          ],
          async () => {
            // These spies belong to the parent; the real worker isolates read the seeded rows.
            await expect(capturePluginModelCatalogAuth(agentDir, state.env)).resolves.toEqual([
              authOwner(
                sharedPath,
                { "fixture:shared": ["synthetic-access", "synthetic-refresh"] },
                "shared-state",
              ),
              authOwner(localPath, { "fixture:local": ["synthetic-key"] }),
            ]);
          },
        );
      },
    );
  }));

it("refuses an unreadable local store instead of publishing a partial auth snapshot", () =>
  withOpenClawTestState({ label: "catalog-auth-unreadable" }, async (state) => {
    const { agentDir, localPath } = await seedAuthRows(state, {
      version: 1,
      profiles: "invalid-profile-map",
    });

    await expect(capturePluginModelCatalogAuth(agentDir, state.env)).rejects.toMatchObject({
      code: "AUTH_PROFILE_STORE_UNREADABLE",
      action: "openclaw doctor --fix",
      databasePath: localPath,
    });
  }));
it("returns committed rows when credential stripping skips invalid planned catalogs", () =>
  withOpenClawTestState({ label: "catalog-auth-receipt" }, async (state) => {
    const agentDir = state.agentDir("helper");
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
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
    await replaceCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encode("keep")]: keep,
        [encode("null-row")]: catalogContents("null-row"),
        [encode("stale")]: catalogContents("stale"),
      },
    });
    await closeOpenClawAgentDatabasesAsync();
    {
      using database = new DatabaseSync(databasePath);
      database
        .prepare("UPDATE cache_entries SET value_json = NULL WHERE scope = ? AND key = ?")
        .run("plugin-model-catalog-v1", "null-row");
    }

    const publication = await replaceCatalogs({
      agentDir,
      authSnapshot: [authOwner(databasePath, { removed: ["synthetic-removed"] })],
      pluginCatalogWrites: {
        [encode("keep")]: "{",
        [encode("absent")]: "{",
        [encode("null-row")]: "{",
        [encode("next")]: catalogContents("next", "synthetic-removed"),
      },
    });
    const expected = [
      { pluginId: "keep", contents: keep },
      { pluginId: "next", contents: catalogContents("next") },
    ];
    expect(publication).toEqual({ changed: true, catalogs: expected });
    expect(readCatalogs(agentDir)).toEqual(expected);
    using snapshot = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      snapshot
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get("plugin-model-catalog-v1", "null-row"),
    ).toEqual({ value_json: null });
  }));
