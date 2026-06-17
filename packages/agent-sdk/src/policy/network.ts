// @openclaw/agent-sdk — Network policy enforcement (DNS rebinding protection, egress control).

import {
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isIpv4Address,
  isIpv6Address,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
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
  void denyRanges;
  const parsed = parseCanonicalIpAddress(ip);
  if (!parsed) return { isPrivate: false };
  if (isIpv4Address(parsed) && isBlockedSpecialUseIpv4Address(parsed)) {
    return { isPrivate: true, matchedRange: parsed.range() };
  }
  if (isIpv6Address(parsed) && isBlockedSpecialUseIpv6Address(parsed)) {
    return { isPrivate: true, matchedRange: parsed.range() };
  }
  return { isPrivate: false };
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
