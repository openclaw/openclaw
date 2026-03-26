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
 * Internal queue to serialize capability cache updates and prevent race conditions.
 */
let updateQueue: Promise<void> = Promise.resolve();

/**
 * Updates the capabilities for a specific model in the cache and persists it.
 * Updates are serialized to prevent data loss from concurrent read-modify-write operations.
 */
export async function updateModelCapability(
  configDir: string,
  providerId: string,
  modelId: string,
  status: CapabilityStatus,
): Promise<void> {
  // Push the update into the queue to ensure serial execution
  updateQueue = updateQueue
    .then(async () => {
      const cache = await loadCapabilities(configDir);
      const key = `${providerId}:${modelId}`;

      cache[key] = {
        status,
        lastVerified: Date.now(),
      };

      await writeJsonFileAtomically(getCachePath(configDir), cache);
    })
    .catch((err) => {
      // Log error but don't break the promise chain for future updates
      console.error(
        `[capabilities-cache] Failed to update capability for ${providerId}:${modelId}:`,
        err,
      );
    });

  return updateQueue;
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
