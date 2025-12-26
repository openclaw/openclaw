import { type ClawdisConfig, loadConfig } from "../config/config.js";
import { resolveClawdisAgentDir } from "./agent-paths.js";
import { ensureClawdisModelsJson } from "./models-config.js";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
};

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
}

export async function loadModelCatalog(params?: {
  config?: ClawdisConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
  }
  if (modelCatalogPromise) return modelCatalogPromise;

  modelCatalogPromise = (async () => {
    const piSdk = await import("@mariozechner/pi-coding-agent");

    const models: ModelCatalogEntry[] = [];
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureClawdisModelsJson(cfg);
      const agentDir = resolveClawdisAgentDir();
      const authStorage = piSdk.discoverAuthStorage(agentDir);
      const registry = piSdk.discoverModels(authStorage, agentDir);
      const entries = registry.getAll();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) continue;
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) continue;
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        models.push({ id, name, provider, contextWindow });
      }
    } catch {
      // Leave models empty on discovery errors.
    }

    return models.sort((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) return p;
      return a.name.localeCompare(b.name);
    });
  })();

  return modelCatalogPromise;
}
