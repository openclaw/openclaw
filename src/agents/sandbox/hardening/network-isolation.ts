/**
 * Network isolation configuration and Docker CLI flag builder for sandbox containers.
 */

/** Docker network mode. "none" isolates completely; "bridge" is default Docker networking. */
export type NetworkMode = "none" | "bridge" | (string & {});

/**
 * Converts a NetworkMode string into a Docker --network flag.
 */
export function buildNetworkFlag(mode: NetworkMode): string[] {
  return [`--network=${mode}`];
}
