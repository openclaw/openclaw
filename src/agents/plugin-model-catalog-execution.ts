import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import type { PluginModelCatalogCredentialOperations } from "./plugin-model-catalog.worker.js";

/** The canonical executor owns preparation, publication, and custody settlement. */
export async function withPluginModelCatalogWorker<T>(
  options: OpenClawAgentDatabaseOptions,
  prepare: boolean,
  operation: (
    scope: Pick<SqliteWorkerStore<PluginModelCatalogCredentialOperations>, "execute">,
  ) => Promise<T>,
): Promise<T> {
  const execution = captureOpenClawAgentDatabaseExecution(options);
  let worker: OpenClawAgentSqliteWorkerStore<PluginModelCatalogCredentialOperations> | undefined;
  try {
    if (prepare) {
      await runOpenClawAgentWorkerWrite(options, () =>
        execution.prepare({
          assertCurrent: () => execution.assertCurrent(),
          createAdmission(binding) {
            return () => ({
              nativeLocations: binding.nativeLocations,
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                binding.authorize(request);
                execution.assertCurrent();
                if (!grant()) {
                  throw new Error("Catalog database preparation authority expired");
                }
              }, binding.attachment),
            });
          },
        }),
      );
    }
    worker = await openOpenClawAgentSqliteWorkerStore<PluginModelCatalogCredentialOperations>(
      options,
      { execution },
      {
        moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pluginModelCatalogCredentials),
        input: undefined,
      },
    );
    return await worker.run(operation, () => execution.assertCurrent());
  } finally {
    try {
      await worker?.close();
    } finally {
      await execution.release();
    }
  }
}
