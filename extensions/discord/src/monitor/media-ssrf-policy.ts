import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

const DISCORD_CDN_HOSTNAMES = [
  "cdn.discordapp.com",
  "media.discordapp.net",
  "*.discordapp.com",
  "*.discordapp.net",
];

// Discord CDN DNS can resolve to RFC2544 benchmark ranges behind VPNs and proxies.
const DISCORD_MEDIA_SSRF_POLICY: SsrFPolicy = {
  hostnameAllowlist: DISCORD_CDN_HOSTNAMES,
  allowRfc2544BenchmarkRange: true,
};

function mergeHostnameList(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = lists
    .flatMap((list) => list ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return merged.length > 0 ? uniqueStrings(merged) : undefined;
}

/** Inherit explicit host/proxy exceptions, never browser-wide private-network access. */
export function resolveDiscordCdnPolicy(policy?: SsrFPolicy): SsrFPolicy {
  if (!policy) {
    return DISCORD_MEDIA_SSRF_POLICY;
  }
  return {
    ...DISCORD_MEDIA_SSRF_POLICY,
    hostnameAllowlist: mergeHostnameList(
      DISCORD_MEDIA_SSRF_POLICY.hostnameAllowlist,
      policy.hostnameAllowlist,
    ),
    allowedHostnames: mergeHostnameList(policy.allowedHostnames),
    allowedOrigins: policy.allowedOrigins,
    blockedHostnames: policy.blockedHostnames,
    allowIpv6UniqueLocalRange: policy.allowIpv6UniqueLocalRange,
  };
}
