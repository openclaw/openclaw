import { getSandboxBackendManager } from "./backend.js";
import { readRegistry, removeRegistryEntry } from "./registry.js";

/**
 * Removes a sandbox runtime that one attempt created for itself.
 *
 * Mirrors the prune teardown order: stop the backing runtime through its
 * backend manager first, then drop the registry entry, so the registry never
 * advertises a runtime that is already gone.
 *
 * Throws when the owning backend is unavailable or rejects removal. Callers
 * unwinding from an earlier failure must catch and log; a teardown error must
 * never replace the error that caused the failure.
 */
export async function removeCreatedSandboxRuntime(containerName: string): Promise<void> {
  const registry = await readRegistry();
  const entry = registry.entries.find((candidate) => candidate.containerName === containerName);
  if (!entry) {
    return;
  }
  const backendId = entry.backendId ?? "docker";
  const manager = getSandboxBackendManager(backendId);
  if (!manager) {
    throw new Error(
      `Sandbox backend "${backendId}" is unavailable; cannot remove runtime ${containerName}.`,
    );
  }
  const { getRuntimeConfig } = await import("../../config/config.js");
  await manager.removeRuntime({ entry, config: getRuntimeConfig() });
  await removeRegistryEntry(containerName);
}
