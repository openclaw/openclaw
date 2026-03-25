import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";

export type CapabilityStatus = "native" | "react" | "unknown";

export interface ModelCapabilities {
  status: CapabilityStatus;
  lastVerified: number;
}

export type CapabilityMap = Record<string, ModelCapabilities>;

function getCachePath(configDir: string): string {
  // Store in mpm subfolder where other metadata lives
  return path.join(configDir, "mpm", "model_caps.json");
}

/**
 * Loads the capabilities cache from disk.
 */
export async function loadCapabilities(configDir: string): Promise<CapabilityMap> {
  const { value } = await readJsonFileWithFallback<CapabilityMap>(getCachePath(configDir), {});
  return value;
}

/**
 * Updates the capabilities for a specific model in the cache and persists it.
 */
export async function updateModelCapability(
  configDir: string,
  providerId: string,
  modelId: string,
  status: CapabilityStatus,
): Promise<void> {
  const cache = await loadCapabilities(configDir);
  const key = `${providerId}:${modelId}`;

  cache[key] = {
    status,
    lastVerified: Date.now(),
  };

  await writeJsonFileAtomically(getCachePath(configDir), cache);
}

/**
 * Checks the status for a given model.
 */
export async function getModelCapability(
  configDir: string,
  providerId: string,
  modelId: string,
): Promise<CapabilityStatus> {
  const cache = await loadCapabilities(configDir);
  const key = `${providerId}:${modelId}`;
  return cache[key]?.status ?? "unknown";
}
