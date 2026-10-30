import { parentPort, workerData } from "node:worker_threads";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSqliteWorkerTransferOwner } from "../infra/sqlite-worker-transfer.js";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import type {
  PluginModelCatalogReadInput,
  PluginModelCatalogReadResult,
} from "./plugin-model-catalog-read.types.js";
import { stripPluginModelCatalogCredentials } from "./plugin-model-catalog-repair.js";
import {
  PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
  PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
  readPluginModelCatalogEntries,
} from "./plugin-model-catalog.kernel.js";

if (parentPort && workerData?.pluginCatalogRead === true) {
  serveOwnedWorkerTasks<PluginModelCatalogReadResult, PluginModelCatalogReadInput>(
    async (input, channel) => {
      if (!channel) {
        throw new Error("Plugin catalog read requires a result channel");
      }
      const scope = new OpenClawAgentDatabaseReadOnlyScope();
      let catalogs;
      try {
        const result = scope.read(
          ({ db }) =>
            readPluginModelCatalogEntries(db, PLUGIN_MODEL_CATALOG_CACHE_SCOPE, input.pluginIds),
          input,
        );
        catalogs = result.found ? result.value : [];
      } catch (error) {
        // Report ordinary refusal only after native cleanup succeeds; failed close retires the worker.
        return { error: error instanceof Error ? error.message : String(error) };
      } finally {
        scope.close();
      }
      const transfer = createSqliteWorkerTransferOwner();
      const handle = transfer.start([{ kind: "catalogs", value: catalogs }].values(), {
        kinds: ["catalogs"],
      });
      try {
        for (;;) {
          const frame = transfer.next(handle.id);
          const response = await channel.request({ handle, frames: [frame] });
          response.consumed();
          if (frame.done) {
            break;
          }
        }
      } finally {
        transfer.close();
      }
      return undefined;
    },
    { retireOnError: true },
  );
}

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
