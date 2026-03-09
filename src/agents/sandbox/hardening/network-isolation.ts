/**
 * Network isolation configuration and Docker CLI flag builder for sandbox containers.
 */

import type { NetworkMode } from "../types.js";

/** Default network mode for sandbox containers. */
export const DEFAULT_NETWORK_MODE: NetworkMode = "bridge";

/**
 * Converts a NetworkMode string into a Docker --network flag.
 */
export function buildNetworkFlag(mode: NetworkMode): string[] {
  return [`--network=${mode}`];
}
