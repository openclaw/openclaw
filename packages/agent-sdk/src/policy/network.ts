// @openclaw/agent-sdk — Network policy enforcement (DNS rebinding protection, egress control).

import { DEFAULT_DENY_PRIVATE_RANGES } from "../index.js";
import type { NetworkPolicy } from "../index.js";

export interface EgressCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a domain is in the denied list.
 * Supports exact match and wildcard prefix (*.example.com).
 */
function isDeniedDomain(domain: string, deniedDomains: string[]): boolean {
  const lower = domain.toLowerCase();
  for (const pattern of deniedDomains) {
    const lowerPattern = pattern.toLowerCase();
    if (lowerPattern.startsWith("*.")) {
      // Wildcard: *.example.com matches foo.example.com and example.com
      const suffix = lowerPattern.slice(1); // .example.com
      if (lower === lowerPattern.slice(2) || lower.endsWith(suffix)) {
        return true;
      }
    } else if (lower === lowerPattern) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether a domain is in the allowed list.
 * Supports exact match and wildcard prefix (*.example.com).
 */
function isAllowedDomain(domain: string, allowedDomains: string[]): boolean {
  const lower = domain.toLowerCase();
  for (const pattern of allowedDomains) {
    const lowerPattern = pattern.toLowerCase();
    if (lowerPattern.startsWith("*.")) {
      const suffix = lowerPattern.slice(1);
      if (lower === lowerPattern.slice(2) || lower.endsWith(suffix)) {
        return true;
      }
    } else if (lower === lowerPattern) {
      return true;
    }
  }
  return false;
}

/**
 * Validate network egress for a given domain.
 *
 * Enforcement order:
 * 1. If egress is "none" → deny all.
 * 2. Denied domains always win (takes precedence over allowed).
 * 3. If allowed domains list exists, domain must be in it.
 * 4. If egress is "restricted" and no allowed list → deny.
 * 5. If egress is "full" → allow (unless denied).
 */
export function checkNetworkEgress(domain: string, policy: NetworkPolicy): EgressCheckResult {
  // Egress mode check
  if (policy.egress === "none") {
    return { allowed: false, reason: "network egress is disabled (egress=none)" };
  }

  // Denied domains always take precedence
  const deniedDomains = policy.deniedDomains ?? [];
  if (isDeniedDomain(domain, deniedDomains)) {
    return { allowed: false, reason: `domain is denied: ${domain}` };
  }

  // If allowed list exists, domain must match it
  const allowedDomains = policy.allowedDomains ?? [];
  if (allowedDomains.length > 0) {
    if (!isAllowedDomain(domain, allowedDomains)) {
      return { allowed: false, reason: `domain not in allowed list: ${domain}` };
    }
    return { allowed: true };
  }

  // No allowed list + restricted mode → deny
  if (policy.egress === "restricted") {
    return { allowed: false, reason: `restricted egress with no allowed list: ${domain}` };
  }

  // Full egress + not denied → allow
  return { allowed: true };
}

/**
 * Check if an IP address is in a denied private range.
 * Used for DNS rebinding protection.
 *
 * Note: This is a string-based check. For production use, the net-policy
 * package (@openclaw/net-policy) provides full IP range matching via ipaddr.js.
 * This function provides a lightweight check for common private ranges.
 */
export function isPrivateIp(
  ip: string,
  denyRanges: string[] = [...DEFAULT_DENY_PRIVATE_RANGES],
): {
  isPrivate: boolean;
  matchedRange?: string;
} {
  // Handle IPv4
  if (ip.includes(".")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return { isPrivate: false };
    }

    const [a, b] = parts;

    // 10.0.0.0/8
    if (a === 10 && denyRanges.includes("10.0.0.0/8")) {
      return { isPrivate: true, matchedRange: "10.0.0.0/8" };
    }
    // 172.16.0.0/12 (172.16.0.0 – 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31 && denyRanges.includes("172.16.0.0/12")) {
      return { isPrivate: true, matchedRange: "172.16.0.0/12" };
    }
    // 192.168.0.0/16
    if (a === 192 && b === 168 && denyRanges.includes("192.168.0.0/16")) {
      return { isPrivate: true, matchedRange: "192.168.0.0/16" };
    }
    // 127.0.0.0/8
    if (a === 127 && denyRanges.includes("127.0.0.0/8")) {
      return { isPrivate: true, matchedRange: "127.0.0.0/8" };
    }
  }

  // Handle IPv6
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    // ::1/128
    if (lower === "::1" && denyRanges.includes("::1/128")) {
      return { isPrivate: true, matchedRange: "::1/128" };
    }
    // fd00::/8 (starts with fd)
    // Handle compressed forms too: ::fd00, fd00::, etc.
    const expanded = expandIpv6(lower);
    if (expanded && expanded.startsWith("fd") && denyRanges.includes("fd00::/8")) {
      return { isPrivate: true, matchedRange: "fd00::/8" };
    }
  }

  return { isPrivate: false };
}

/**
 * Minimal IPv6 expansion for private range checking.
 * Handles common compressed forms like ::1, fd00::, ::fd00.
 */
function expandIpv6(ip: string): string | null {
  try {
    // Handle :: abbreviation
    let expanded = ip;
    if (expanded.includes("::")) {
      const parts = expanded.split("::");
      const left = parts[0] ? parts[0].split(":") : [];
      const right = parts[1] ? parts[1].split(":") : [];
      const missing = 8 - left.length - right.length;
      const middle = new Array(missing).fill("0");
      expanded = [...left, ...middle, ...right].join(":");
    }

    // Pad each group to 4 hex digits
    const groups = expanded.split(":");
    if (groups.length !== 8) return null;

    return groups
      .map((g) => g.padStart(4, "0"))
      .join(":")
      .toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Full DNS rebinding check.
 * 1. Check domain against denied/allowed lists.
 * 2. Check resolved IP against private ranges.
 * Returns on first failure.
 */
export function checkDnsRebinding(
  domain: string,
  resolvedIp: string,
  policy: NetworkPolicy,
): EgressCheckResult {
  // Step 1: Domain-level check
  const domainResult = checkNetworkEgress(domain, policy);
  if (!domainResult.allowed) {
    return domainResult;
  }

  // Step 2: IP-level check (DNS rebinding protection)
  if (policy.denyPrivateRanges !== false) {
    const ipCheck = isPrivateIp(resolvedIp);
    if (ipCheck.isPrivate) {
      return {
        allowed: false,
        reason: `DNS rebinding: ${domain} resolved to private IP ${resolvedIp} (${ipCheck.matchedRange})`,
      };
    }
  }

  return { allowed: true };
}
