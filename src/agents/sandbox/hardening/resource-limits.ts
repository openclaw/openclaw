/**
 * Resource limit configuration and Docker CLI flag builder for sandbox containers.
 */

import type { ResourceLimits } from "../types.js";

/** Sensible defaults for sandboxed agent containers. */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpus: 1,
  memoryMB: 512,
  pidsLimit: 256,
};

/**
 * Converts a ResourceLimits config into Docker CLI flags.
 * Only includes flags for fields that are defined.
 */
export function buildResourceLimitFlags(limits: ResourceLimits): string[] {
  const flags: string[] = [];

  if (limits.cpus !== undefined) {
    flags.push(`--cpus=${limits.cpus}`);
  }

  if (limits.memoryMB !== undefined) {
    flags.push(`--memory=${limits.memoryMB}m`);
  }

  if (limits.pidsLimit !== undefined) {
    flags.push(`--pids-limit=${limits.pidsLimit}`);
  }

  if (limits.diskMB !== undefined) {
    flags.push(`--storage-opt=size=${limits.diskMB}m`);
  }

  return flags;
}
