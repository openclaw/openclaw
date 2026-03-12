/**
 * Network isolation configuration and Docker CLI flag builder for sandbox containers.
 *
 * Includes egress filtering to block cloud metadata endpoints from inside containers,
 * preventing SSRF attacks via exec (curl/wget) that bypass application-level URL validation.
 */

import { execDockerRaw } from "../docker.js";
import type { NetworkMode } from "../types.js";

/** Default network mode for sandbox containers. */
export const DEFAULT_NETWORK_MODE: NetworkMode = "bridge";

/**
 * Cloud metadata endpoints that must be blocked at the network level.
 * These are the targets of SSRF attacks that attempt to steal IAM credentials,
 * instance identity tokens, or other sensitive cloud metadata.
 */
const METADATA_BLOCK_TARGETS = [
  // AWS / GCP / Azure instance metadata (IPv4 link-local)
  "169.254.169.254",
  // AWS EC2 IPv6 metadata endpoint
  "fd00:ec2::254",
  // Alibaba Cloud metadata endpoint
  "100.100.100.200",
];

/**
 * Converts a NetworkMode string into a Docker --network flag.
 */
export function buildNetworkFlag(mode: NetworkMode): string[] {
  return [`--network=${mode}`];
}

/**
 * Apply iptables/ip6tables rules inside a running container to block egress
 * to cloud metadata endpoints. This is the primary SSRF defense for Docker/gVisor
 * containers — it operates at the network layer so it cannot be bypassed by
 * curl, wget, or any other tool the agent might use.
 *
 * Requires NET_ADMIN capability (added via --cap-add=NET_ADMIN at create time)
 * or the container must have iptables available and permission to modify rules.
 *
 * Silently succeeds if iptables is not available (e.g., in --network=none mode
 * where there's no network to filter anyway).
 */
export async function applyMetadataEgressBlock(containerName: string): Promise<void> {
  const rules: string[] = [];
  for (const target of METADATA_BLOCK_TARGETS) {
    if (target.includes(":")) {
      // IPv6
      rules.push(`ip6tables -A OUTPUT -d ${target} -j DROP 2>/dev/null`);
    } else {
      // IPv4
      rules.push(`iptables -A OUTPUT -d ${target} -j DROP 2>/dev/null`);
    }
  }
  // Also block DNS resolution of known metadata hostnames via iptables string match
  // is fragile, so we add /etc/hosts poisoning as defense-in-depth.
  const hostsEntries = ["0.0.0.0 metadata.google.internal", "0.0.0.0 metadata.google.internal."];
  const hostsCmd = hostsEntries.map((e) => `echo '${e}' >> /etc/hosts`).join(" && ");

  const fullCmd = [...rules, hostsCmd].join(" ; ");

  await execDockerRaw(["exec", containerName, "sh", "-c", fullCmd], {
    allowFailure: true,
  });
}
