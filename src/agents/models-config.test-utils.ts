import { resolveDefaultAgentDir } from "./agent-scope.js";
import { readStoredModelsConfigRaw } from "./models-config-store.js";

export async function readStoredModelCatalog<T>(agentDir = resolveDefaultAgentDir({})): Promise<T> {
  const stored = readStoredModelsConfigRaw(agentDir);
  if (!stored) {
    throw new Error(`expected stored model catalog for ${agentDir}`);
  }
  return JSON.parse(stored.raw) as T;
}
