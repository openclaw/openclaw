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

/** Merges caller hostname lists with the Discord CDN allowlist. */
export function resolveDiscordCdnPolicy(policy?: SsrFPolicy): SsrFPolicy {
  if (!policy) {
    return DISCORD_MEDIA_SSRF_POLICY;
  }
  const hostnameAllowlist = mergeHostnameList(
    DISCORD_MEDIA_SSRF_POLICY.hostnameAllowlist,
    policy.hostnameAllowlist,
  );
  const allowedHostnames = mergeHostnameList(
    DISCORD_MEDIA_SSRF_POLICY.allowedHostnames,
    policy.allowedHostnames,
  );
  const {
    allowPrivateNetwork: _allowPrivateNetwork,
    dangerouslyAllowPrivateNetwork: _dangerouslyAllowPrivateNetwork,
    allowIpv6UniqueLocalRange: _allowIpv6UniqueLocalRange,
    hostnameAllowlist: _hostnameAllowlist,
    allowedHostnames: _allowedHostnames,
    allowRfc2544BenchmarkRange: _allowRfc2544BenchmarkRange,
    ...callerRest
  } = policy;
  return {
    ...DISCORD_MEDIA_SSRF_POLICY,
    ...callerRest,
    ...(allowedHostnames ? { allowedHostnames } : {}),
    ...(hostnameAllowlist ? { hostnameAllowlist } : {}),
    allowRfc2544BenchmarkRange:
      Boolean(DISCORD_MEDIA_SSRF_POLICY.allowRfc2544BenchmarkRange) ||
      Boolean(policy.allowRfc2544BenchmarkRange),
  };
}
