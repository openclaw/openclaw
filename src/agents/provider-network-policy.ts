import {
  isCloudMetadataIpAddress,
  isLinkLocalIpAddress,
  isRfc8215LocalUseNat64Ipv6Address,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import {
  mergeSsrFPolicies,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  SsrFBlockedError,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

const BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS = new Set(["instance-data"]);

function resolveHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = URL.parse(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return undefined;
  }
  parsed.hostname = parsed.hostname.replace(/\.+$/, "");
  return parsed.origin.toLowerCase();
}

function normalizeProviderOriginHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = URL.parse(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return undefined;
  }
  return parsed.hostname.trim().toLowerCase().replace(/\.+$/, "") || undefined;
}

export function resolveProviderTransportSsrFPolicy(params: {
  baseUrl?: string;
  url: string;
  allowPrivateNetwork?: boolean;
  trustConfiguredBaseUrlOrigin?: boolean;
}): SsrFPolicy | undefined {
  const baseUrl = params.baseUrl;
  const baseOrigin = resolveHttpOrigin(baseUrl);
  const requestOrigin = resolveHttpOrigin(params.url);
  const requestMatchesBaseOrigin =
    typeof baseUrl === "string" && Boolean(baseOrigin) && requestOrigin === baseOrigin;
  const hostname = requestMatchesBaseOrigin ? normalizeProviderOriginHostname(baseUrl) : undefined;
  const eligibleHostname =
    hostname &&
    !hostname
      .split(".")
      .filter(Boolean)
      .some(
        (label) =>
          label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
      );
  const baseUrlOriginPolicy =
    requestMatchesBaseOrigin &&
    params.trustConfiguredBaseUrlOrigin &&
    eligibleHostname &&
    !isLinkLocalIpAddress(hostname) &&
    !isCloudMetadataIpAddress(hostname) &&
    !isRfc8215LocalUseNat64Ipv6Address(hostname)
      ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)
      : undefined;
  // Fake-IP trust is hostname-scoped and orthogonal to exact-origin private-IP trust.
  // It is for DNS hostnames only and does not allow literal private IPs by itself.
  const fakeIpPolicy =
    requestMatchesBaseOrigin && eligibleHostname && !parseCanonicalIpAddress(hostname)
      ? ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl)
      : undefined;
  return mergeSsrFPolicies(
    baseUrlOriginPolicy,
    fakeIpPolicy,
    params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
  );
}

export function withModelProviderNetworkRemediation(
  error: unknown,
  params: {
    baseUrl?: string;
    providerId: string;
    url: string;
  },
): unknown {
  const baseOrigin = resolveHttpOrigin(params.baseUrl);
  const requestOrigin = resolveHttpOrigin(params.url);
  const hostname = normalizeProviderOriginHostname(params.baseUrl);
  if (
    !(error instanceof SsrFBlockedError) ||
    !baseOrigin ||
    requestOrigin !== baseOrigin ||
    !hostname ||
    !isRfc8215LocalUseNat64Ipv6Address(hostname)
  ) {
    return error;
  }
  return new SsrFBlockedError(
    `Configured model provider ${params.providerId} uses local-use NAT64 origin ` +
      `${baseOrigin}, which OpenClaw blocks by default. Move the provider to a ` +
      `loopback, LAN, or tailnet address, or set ` +
      `models.providers.${params.providerId}.request.allowPrivateNetwork=true only for an ` +
      `operator-controlled endpoint. Original block: ${error.message}`,
  );
}
