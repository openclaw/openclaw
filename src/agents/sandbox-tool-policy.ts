/**
 * Converts user-facing sandbox tool policy config into the normalized runtime
 * allow/deny policy object used by tool filtering.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SandboxToolPolicy } from "./sandbox/types.js";

/** Provenance marker for wildcard allowlists created from `alsoAllow`. */
export const IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW = Symbol.for(
  "openclaw.toolPolicy.implicitAllowAllFromAlsoAllow",
);

type SandboxToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};

/** Picks the effective sandbox tool policy from allow/alsoAllow/deny config. */
export function pickSandboxToolPolicy(
  config?: SandboxToolPolicyConfig,
): SandboxToolPolicy | undefined {
  if (!config) {
    return undefined;
  }
  const base = Array.isArray(config.allow) ? config.allow : undefined;
  const extra = Array.isArray(config.alsoAllow) ? config.alsoAllow : undefined;
  const allowFromAlsoAllowOnly =
    !base && extra && extra.length > 0 && !extra.some((entry) => entry.trim() === "*");
  // `alsoAllow` extends defaults when no nonempty allow list was authored.
  const allow = extra?.length ? uniqueStrings([...(base?.length ? base : ["*"]), ...extra]) : base;
  const deny = Array.isArray(config.deny) ? config.deny : undefined;
  if (!allow && !deny) {
    return undefined;
  }
  const policy = { allow, deny } as SandboxToolPolicy & {
    [IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW]?: true;
  };
  if (allowFromAlsoAllowOnly) {
    // Preserve provenance for downstream diagnostics: this allow-all came from
    // `alsoAllow`, not from an operator-authored explicit wildcard.
    Object.defineProperty(policy, IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW, {
      value: true,
    });
  }
  return policy;
}
