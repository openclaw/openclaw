import { resolveClawdisAgentDir } from "./agent-paths.js";
import { type ClawdisConfig, loadConfig } from "../config/config.js";
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
    const piSdk = (await import("@mariozechner/pi-coding-agent")) as {
      discoverModels: (agentDir?: string) => Array<{
        id: string;
        name?: string;
        provider: string;
        contextWindow?: number;
      }>;
    };

    let entries: Array<{
      id: string;
      name?: string;
      provider: string;
      contextWindow?: number;
    }> = [];
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureClawdisModelsJson(cfg);
      entries = piSdk.discoverModels(resolveClawdisAgentDir());
    } catch {
      entries = [];
    }

    const models: ModelCatalogEntry[] = [];
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

    return models.sort((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) return p;
      return a.name.localeCompare(b.name);
    });
  })();

  return modelCatalogPromise;
}
