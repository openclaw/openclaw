import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { runOutsideAgentDatabasePreparation } from "../state/agent-database-admission.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { capturePluginModelCatalogAuth } from "./plugin-model-catalog-auth.js";
import { loadPersistedPluginModelCatalogs } from "./plugin-model-catalog-execution.js";
import {
  encodePluginModelCatalogRelativePath,
  pruneRemovedProviderPluginModelCatalogs,
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
    // Share the models.json queue with the other writers of this agent's catalogs. Discovery
    // can outlive the startup preparation that started it; write as an ordinary caller.
    await MODELS_JSON_STATE.writeQueue
      .enqueue(path.join(agentDir, "models.json"), () =>
        runOutsideAgentDatabasePreparation(() =>
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
        ),
      )
      .catch((error: unknown) => {
        // The rows still publish; only the copy for the next start is lost.
        process.emitWarning(`Could not save the discovered model catalog: ${String(error)}`);
      });
  };
}

/**
 * Signing out of a provider ends the account whose listing was saved. Drop its saved rows first,
 * so the next sign-in (another account or an API key) starts from its own listing.
 */
export async function forgetSignedOutPluginModelCatalogRows(agentDir: string, provider: string) {
  const providerId = normalizeProviderId(provider);
  const removedProviderBaseUrls: Record<string, string> = {};
  for (const { contents } of await loadPersistedPluginModelCatalogs(agentDir)) {
    // SAFETY: the models.json plan serializes each generated catalog with a providers record.
    const { providers = {} } = JSON.parse(contents) as {
      providers?: Record<string, { baseUrl?: unknown }>;
    };
    for (const [id, entry] of Object.entries(providers)) {
      if (normalizeProviderId(id) === providerId && typeof entry.baseUrl === "string") {
        removedProviderBaseUrls[id] = entry.baseUrl;
      }
    }
  }
  await pruneRemovedProviderPluginModelCatalogs({ agentDir, removedProviderBaseUrls });
}
