import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

export function resolveCdpReachabilityPolicy(
  profile: ResolvedBrowserProfile,
  ssrfPolicy?: SsrFPolicy,
): SsrFPolicy | undefined {
  const capabilities = getBrowserProfileCapabilities(profile);
  if (
    capabilities.mode === "local-managed" &&
    profile.cdpIsLoopback &&
    !profile.attachOnly &&
    profile.driver === "openclaw"
  ) {
    return undefined;
  }
  return ssrfPolicy;
}

export const resolveCdpControlPolicy = resolveCdpReachabilityPolicy;
