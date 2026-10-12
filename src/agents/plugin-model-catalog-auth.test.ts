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
import { writeAuthProfileJsonCell } from "./auth-profiles/sqlite-json.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { capturePluginModelCatalogAuth } from "./plugin-model-catalog-auth.js";

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
});
