// Per-agent network policy (RI-026)
// A network policy tells the sandbox runtime how much outbound network access
// an agent gets. The simple two-mode subset (`none` + `open`) is fully
// enforced via Docker's native `--network` flag. A richer `allowlist` mode is
// parseable and loadable today but its enforcement is deferred to RI-028,
// which introduces an outbound proxy sidecar that can filter HTTP traffic by
// host. Until RI-028 lands, `allowlist` mode is treated as `open` at the
// Docker level with a warning logged at spawn time.
//
// Storage: network-policies.json in the OpenClaw state dir. Shape:
//   {
//     "version": 1,
//     "policies": [
//       { "agentId": "quinn", "mode": "open" },
//       { "agentId": "jack",  "mode": "none" },
//       {
//         "agentId": "nora",
//         "mode": "allowlist",
//         "allowedHosts": ["api.anthropic.com", "api.hubspot.com"]
//       }
//     ]
//   }
//
// Scope isolation: each sandbox spawn only sees ITS agent's policy. Policies
// are never merged across agents.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../../config/config.js";

export type NetworkPolicyMode = "none" | "open" | "allowlist";

export interface NetworkPolicy {
  agentId: string;
  mode: NetworkPolicyMode;
  allowedHosts?: string[];
  allowedPorts?: number[];
  updatedAt?: string;
}

export interface NetworkPolicyFile {
  version: number;
  policies: NetworkPolicy[];
}

export const NETWORK_POLICY_FILE_NAME = "network-policies.json";

export function resolveDefaultPolicyFilePath(): string {
  return join(STATE_DIR, NETWORK_POLICY_FILE_NAME);
}

export function loadNetworkPoliciesFile(
  path: string = resolveDefaultPolicyFilePath(),
): NetworkPolicyFile {
  if (!existsSync(path)) {
    return { version: 1, policies: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read network-policies.json at ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `network-policies.json at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as NetworkPolicyFile).policies)
  ) {
    throw new Error(
      `network-policies.json at ${path} is malformed — expected { version, policies: [] }`,
    );
  }
  const file = parsed as NetworkPolicyFile;
  for (const policy of file.policies) {
    assertValidPolicy(policy, path);
  }
  return file;
}

export function loadNetworkPolicyForAgent(
  agentId: string,
  path: string = resolveDefaultPolicyFilePath(),
): NetworkPolicy | null {
  const normalized = agentId.trim().toLowerCase();
  if (!normalized) return null;
  const file = loadNetworkPoliciesFile(path);
  return (
    file.policies.find((p) => p.agentId.trim().toLowerCase() === normalized) ??
    null
  );
}

function assertValidPolicy(policy: NetworkPolicy, path: string): void {
  if (!policy.agentId || typeof policy.agentId !== "string") {
    throw new Error(`${path}: policy is missing an agentId`);
  }
  if (
    policy.mode !== "none" &&
    policy.mode !== "open" &&
    policy.mode !== "allowlist"
  ) {
    throw new Error(
      `${path}: policy for "${policy.agentId}" has invalid mode "${policy.mode}" — expected none | open | allowlist`,
    );
  }
  if (policy.mode === "allowlist") {
    if (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.length === 0) {
      throw new Error(
        `${path}: policy for "${policy.agentId}" has mode "allowlist" but no allowedHosts`,
      );
    }
    for (const host of policy.allowedHosts) {
      if (typeof host !== "string" || !host.trim()) {
        throw new Error(
          `${path}: policy for "${policy.agentId}" has a non-string or empty entry in allowedHosts`,
        );
      }
    }
  }
}

export interface ResolvedNetworkMode {
  /** Value to pass to `docker --network`. `"none"` for kill-switch, `null` to
   *  use the runtime default (bridge). */
  dockerNetwork: string | null;
  /** True when the policy names a richer enforcement shape than Docker's
   *  built-in flag can express. Caller should log the warning and wire the
   *  RI-028 proxy once it lands. */
  needsProxyEnforcement: boolean;
  /** Short human-readable note for logging. */
  note: string;
}

export function resolveNetworkModeForPolicy(
  policy: NetworkPolicy | null | undefined,
): ResolvedNetworkMode {
  if (!policy) {
    return { dockerNetwork: null, needsProxyEnforcement: false, note: "no policy — default network" };
  }
  if (policy.mode === "none") {
    return {
      dockerNetwork: "none",
      needsProxyEnforcement: false,
      note: `policy "${policy.agentId}" mode=none — outbound network disabled`,
    };
  }
  if (policy.mode === "open") {
    return {
      dockerNetwork: null,
      needsProxyEnforcement: false,
      note: `policy "${policy.agentId}" mode=open — default bridge network`,
    };
  }
  // mode === "allowlist" — enforcement deferred to RI-028 proxy sidecar
  return {
    dockerNetwork: null,
    needsProxyEnforcement: true,
    note: `policy "${policy.agentId}" mode=allowlist (${(policy.allowedHosts ?? []).length} hosts) — enforcement pending RI-028 proxy, currently acts as open`,
  };
}
