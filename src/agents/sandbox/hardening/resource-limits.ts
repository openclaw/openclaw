/**
 * Resource limit configuration and Docker CLI flag builder for sandbox containers.
 */

export interface ResourceLimits {
  /** Number of CPUs (fractional allowed, e.g. 0.5). */
  cpus?: number;
  /** Memory limit string (e.g. "512m", "1g"). */
  memory?: string;
  /** Maximum number of PIDs in the container. */
  pidsLimit?: number;
}

/** Sensible defaults for sandboxed agent containers. */
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  cpus: 1,
  memory: "512m",
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

  if (limits.memory !== undefined) {
    flags.push(`--memory=${limits.memory}`);
  }

  if (limits.pidsLimit !== undefined) {
    flags.push(`--pids-limit=${limits.pidsLimit}`);
  }

  return flags;
}
