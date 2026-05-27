import type { SandboxToolPolicy } from "./sandbox/types.js";

type SandboxToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};

function unionAllow(base?: string[], extra?: string[]): string[] | undefined {
  if (!Array.isArray(extra) || extra.length === 0) {
    return base;
  }
  // If the user is using alsoAllow without an allowlist, treat it as additive on top of
  // an implicit allow-all policy.
  if (!Array.isArray(base) || base.length === 0) {
    return Array.from(new Set(["*", ...extra]));
  }
  return Array.from(new Set([...base, ...extra]));
}

export function pickSandboxToolPolicy(
  config?: SandboxToolPolicyConfig,
): SandboxToolPolicy | undefined {
  if (!config) {
    return undefined;
  }
  const allow = Array.isArray(config.allow)
    ? unionAllow(config.allow, config.alsoAllow)
    : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0
      ? unionAllow(undefined, config.alsoAllow)
      : undefined;
  const deny = Array.isArray(config.deny) ? config.deny : undefined;
  if (!allow && !deny) {
    return undefined;
  }
  return { allow, deny };
}
