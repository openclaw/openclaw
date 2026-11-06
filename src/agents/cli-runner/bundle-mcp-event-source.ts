import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SessionEventSourcePolicy } from "../../auto-reply/reply/session-event-contract.js";
import { TOOL_NAME_SEPARATOR } from "../agent-bundle-mcp-names.js";
import {
  attachToolAllowlistIntersection,
  normalizeToolPolicyName,
  readToolAllowlistIntersection,
} from "../tool-policy-shared.js";

/**
 * Synthetic allowlist name that admits the whole bundled MCP tool family in
 * `shouldCreateBundleMcpRuntimeForAttempt` (run/attempt-tool-construction-plan).
 * Exec completion records persist the producing turn's session-event source
 * policy and wake turns re-admit the runtime only when the recovered
 * allowlist still carries it, so a turn that materialized its bundle MCP
 * surface must record this carrier for its wake chain.
 */
export const BUNDLE_MCP_ALLOWLIST_NAME = "bundle-mcp";

/**
 * Mirrors the explicit carriers the bundled-MCP runtime gate accepts for one
 * restriction: the synthetic family name, concrete `bundle__tool` separator
 * names, the plugin tool group, or a wildcard cap. Plain globs depend on the
 * gate's configured-namespace resolution, so they still gain the carrier.
 */
function allowlistCarriesBundleMcpReach(allowNames: readonly string[]): boolean {
  return allowNames.some((entry) => {
    const normalized = normalizeToolPolicyName(entry);
    return (
      normalized === BUNDLE_MCP_ALLOWLIST_NAME ||
      normalized.includes(TOOL_NAME_SEPARATOR) ||
      normalized === "group:plugins" ||
      normalized === "*"
    );
  });
}

/**
 * Adds the bundled MCP carrier to an allowlist and to every recorded
 * intersection restriction, preserving the independent caps.
 */
function addBundleMcpReach(toolsAllow: readonly string[]): string[] {
  const recorded = readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow];
  const restrictions: string[][] = [];
  for (const restriction of recorded) {
    const extended = restriction.slice();
    if (!allowlistCarriesBundleMcpReach(restriction)) {
      extended.push(BUNDLE_MCP_ALLOWLIST_NAME);
    }
    restrictions.push(extended);
  }
  return attachToolAllowlistIntersection(
    uniqueStrings([...toolsAllow, BUNDLE_MCP_ALLOWLIST_NAME]),
    restrictions,
  );
}

/**
 * Keeps created bundle MCP reach visible across exec completion wakes: an
 * exec completion notification persists this turn's source policy, and the
 * wake turn intersects with it before re-admitting runtimes. Only extends a
 * restricting allowlist — unrestricted policies and shares created with
 * bundle MCP inactive are recorded exactly as received.
 */
export function withBundleMcpEventSourceReach(
  policy: SessionEventSourcePolicy,
  bundleMcpActive: boolean,
): SessionEventSourcePolicy {
  if (!bundleMcpActive || !policy.toolsAllow) {
    return policy;
  }
  const restrictions = readToolAllowlistIntersection(policy.toolsAllow) ?? [policy.toolsAllow];
  if (restrictions.every(allowlistCarriesBundleMcpReach)) {
    return policy;
  }
  return Object.freeze({
    ...policy,
    toolsAllow: addBundleMcpReach(policy.toolsAllow),
  });
}
