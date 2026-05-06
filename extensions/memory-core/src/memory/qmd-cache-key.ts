import type { ResolvedQmdConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

/**
 * Build a cache key for QmdMemoryManager instances.
 *
 * The key includes the agentId, the resolved QMD config, and an optional userId
 * so that per-user managers do not share cached state with the agent-wide one
 * or with managers belonging to other users.
 */
export function buildQmdCacheKey(
  agentId: string,
  config: ResolvedQmdConfig,
  userId?: string,
): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  const base = `${agentId}:${JSON.stringify(config)}`;
  return userId ? `${base}::user:${userId}` : base;
}
