import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import { stripPluginModelCatalogCredentials } from "./plugin-model-catalog-repair.js";
import {
  PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
  PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
} from "./plugin-model-catalog.kernel.js";

export type PluginModelCatalogCredentialCandidate = {
  agentId: string;
  databasePath: string;
};

export const pluginModelCatalogCredentialReadOperations = {
  "pluginModelCatalogCredentials.candidates": (
    input: { candidates: PluginModelCatalogCredentialCandidate[]; credentials: string[] },
    { stateOptions },
  ) => {
    const { env } = stateOptions();
    const credentials = new Set(input.credentials);
    return input.candidates.filter((candidate) => {
      const result = withFreshOpenClawAgentDatabaseReadOnly(
        ({ db }) =>
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "cache_entries">>(db)
              .selectFrom("cache_entries")
              .select("value_json")
              .where("scope", "in", [
                PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
                PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
              ]),
          ).rows.some(
            (row) =>
              row.value_json !== null &&
              stripPluginModelCatalogCredentials(row.value_json, credentials) !== row.value_json,
          ),
        { agentId: candidate.agentId, path: candidate.databasePath, env },
      );
      // An unadmitted schema cannot prove absence; preserve the canonical writer's handling.
      return result.found ? result.value : result.reason === "schema-missing";
    });
  },
} satisfies WorkerOperationHandlers;

export type PluginModelCatalogCredentialReadWorkerOperations = WorkerOperations<
  typeof pluginModelCatalogCredentialReadOperations
>;
