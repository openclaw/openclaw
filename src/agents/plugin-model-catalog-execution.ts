import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import { resolveStateDir } from "../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  assertDatabaseFileIdentity,
  readDatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../state/openclaw-agent-execution.js";
import { executeOpenClawAgentWorkerPublication } from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import { readPluginModelCatalogsInWorker } from "./plugin-model-catalog-read.js";
import type { PersistedPluginModelCatalog } from "./plugin-model-catalog-read.types.js";
import type { PluginModelCatalogCredentialOperations } from "./plugin-model-catalog.worker.js";

/** The canonical executor owns preparation, publication, and custody settlement. */
export async function withPluginModelCatalogWorker<T>(
  options: OpenClawAgentDatabaseOptions,
  prepare: boolean,
  operation: (
    scope: Pick<SqliteWorkerStore<PluginModelCatalogCredentialOperations>, "execute">,
  ) => Promise<T>,
): Promise<T> {
  const execution = await captureOpenClawAgentDatabaseExecutionAsync(options);
  const source = createSessionWorkerExecutionSource(
    () => execution.assertCurrent(),
    "Catalog database publication authority expired",
  );
  try {
    return await runOpenClawAgentWorkerWrite(
      options,
      async () => {
        if (prepare) {
          await execution.prepare(source);
        }
        const result = await execution.runExisting(source, async (scope) => ({
          value: await operation({
            execute: (command, commandOptions) =>
              executeOpenClawAgentWorkerPublication<
                PluginModelCatalogCredentialOperations,
                typeof command.type
              >(
                scope,
                {
                  id: randomUUID(),
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.pluginModelCatalogCredentials,
                  ).href,
                  input: undefined,
                  command,
                },
                commandOptions,
              ),
          }),
        }));
        if (!result) {
          throw new Error("Agent database disappeared before catalog publication");
        }
        return result.value;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      execution.capturedIdentity,
    );
  } finally {
    await execution.release();
  }
}

/** Preparation retains read authority through worker settlement, without admitting a writer. */
export async function loadPersistedPluginModelCatalogs(
  agentDir: string,
  pluginIds?: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PersistedPluginModelCatalog[]> {
  if (pluginIds?.length === 0) {
    return [];
  }
  const env = cloneEnvWithPlatformSemantics(environment);
  const options = {
    agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
    path: resolveAuthProfileDatabasePath(agentDir),
    env,
  };
  const root = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(env));
  const controller = new AbortController();
  let reading: Promise<PersistedPluginModelCatalog[]> | undefined;
  const revoke = () => controller.abort(new Error("Plugin catalog read owner was revoked"));
  const close = async () => {
    revoke();
    await reading?.catch(() => undefined);
  };
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    root.admission.assertCurrent();
    root.maintenanceScope?.assertAdmission();
  };
  const unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({ ...options, revoke, close });
  try {
    reading = (async () => {
      const identity = await readDatabasePathIdentity(options.path);
      assertCurrent();
      if (!identity.key.startsWith("file:")) {
        return [];
      }
      const catalogs = await readPluginModelCatalogsInWorker(
        {
          ...options,
          env: { ...env, OPENCLAW_STATE_DIR: resolveStateDir(env) },
          pluginIds: pluginIds && [...pluginIds],
        },
        controller.signal,
      );
      assertDatabaseFileIdentity(await stat(options.path, { bigint: true }), identity);
      assertCurrent();
      return catalogs;
    })();
    return await reading;
  } finally {
    unregisterAgent();
  }
}
