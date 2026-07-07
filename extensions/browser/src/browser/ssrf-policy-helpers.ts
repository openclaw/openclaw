/**
 * SSRF policy helpers for Browser routes that need one-off hostname grants.
 */
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

/** Returns an SSRF policy with the hostname added to exact-host allowlists. */
export function withAllowedHostname(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  const hostnameAllowlist = ssrfPolicy?.hostnameAllowlist?.length
    ? uniqueStrings([...ssrfPolicy.hostnameAllowlist, hostname])
    : undefined;
  return {
    ...ssrfPolicy,
    allowedHostnames: uniqueStrings([...(ssrfPolicy?.allowedHostnames ?? []), hostname]),
    ...(hostnameAllowlist ? { hostnameAllowlist } : {}),
  };
}
