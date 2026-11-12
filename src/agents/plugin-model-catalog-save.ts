import path from "node:path";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { capturePluginModelCatalogAuth } from "./plugin-model-catalog-auth.js";
import {
  encodePluginModelCatalogRelativePath,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import type { PersistedPluginModelCatalog } from "./plugin-model-catalog.kernel.js";

/**
 * Prepares to save the generated catalogs a Gateway discovery worker accepted. Workers cannot
 * write, so the main thread saves them; a restart or plugin reload then starts from the last
 * accepted rows instead of waiting for discovery. Capture auth before discovery starts, so a
 * credential removed meanwhile is stripped from the saved catalogs.
 */
export async function preparePluginModelCatalogSave(agentDir: string, env: NodeJS.ProcessEnv) {
  const authSnapshot = await capturePluginModelCatalogAuth(agentDir, env);
  return async (pluginCatalogs: readonly PersistedPluginModelCatalog[]) => {
    // Share the models.json queue with the other writers of this agent's catalogs.
    await MODELS_JSON_STATE.writeQueue
      .enqueue(path.join(agentDir, "models.json"), () =>
        replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: Object.fromEntries(
            pluginCatalogs.map(({ pluginId, contents }) => [
              encodePluginModelCatalogRelativePath(pluginId),
              contents,
            ]),
          ),
          authSnapshot,
          env,
        }),
      )
      .catch((error: unknown) => {
        // The rows still publish; only the copy for the next start is lost.
        process.emitWarning(`Could not save the discovered model catalog: ${String(error)}`);
      });
  };
}
