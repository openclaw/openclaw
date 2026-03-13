/**
 * Network isolation configuration and Docker CLI flag builder for sandbox containers.
 *
 * Includes egress filtering to block cloud metadata endpoints from inside containers,
 * preventing SSRF attacks via exec (curl/wget) that bypass application-level URL validation.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { execDockerRaw } from "../docker.js";
import type { NetworkMode } from "../types.js";

const log = createSubsystemLogger("network-isolation");

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
 * When networkMode is "none", skips silently — there is no network to filter.
 * For all other network modes, throws if rules cannot be applied, preventing
 * the sandbox from starting without SSRF protection.
 */
export async function applyMetadataEgressBlock(
  containerName: string,
  networkMode?: NetworkMode,
): Promise<void> {
  if (networkMode === "none") {
    log.debug(`Skipping metadata egress block for ${containerName}: network mode is "none"`);
    return;
  }

  const rules: string[] = [];
  for (const target of METADATA_BLOCK_TARGETS) {
    if (target.includes(":")) {
      // IPv6
      rules.push(`ip6tables -A OUTPUT -d ${target} -j DROP`);
    } else {
      // IPv4
      rules.push(`iptables -A OUTPUT -d ${target} -j DROP`);
    }
  }
  // Also block DNS resolution of known metadata hostnames via iptables string match
  // is fragile, so we add /etc/hosts poisoning as defense-in-depth.
  const hostsEntries = ["0.0.0.0 metadata.google.internal", "0.0.0.0 metadata.google.internal."];
  const hostsCmd = hostsEntries.map((e) => `echo '${e}' >> /etc/hosts`).join(" && ");

  const fullCmd = [...rules, hostsCmd].join(" ; ");

  const result = await execDockerRaw(["exec", containerName, "sh", "-c", fullCmd], {
    allowFailure: true,
  });

  if (result.code !== 0) {
    throw new Error(
      `Metadata egress block failed for ${containerName} (exit ${result.code}). ` +
        `SSRF defense cannot be applied. Ensure NET_ADMIN capability is set. ` +
        `stderr: ${result.stderr.toString().trim()}`,
    );
  }

  // Verify the primary IPv4 metadata rule was actually applied
  const verifyResult = await execDockerRaw(
    ["exec", containerName, "sh", "-c", "iptables -C OUTPUT -d 169.254.169.254 -j DROP"],
    { allowFailure: true },
  );
  if (verifyResult.code !== 0) {
    throw new Error(
      `Metadata egress verification failed for ${containerName}: iptables rule not found after apply. ` +
        `Sandbox cannot start without SSRF protection.`,
    );
  }
}
