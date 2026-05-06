import { isIP } from "node:net";
import {
  isBlockedHostnameOrIp,
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import { matchesHostnameAllowlist, normalizeHostname } from "../sdk-security-runtime.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // Keep non-network navigation explicit; about:blank is the only allowed bootstrap URL.
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

function normalizeNavigationUrl(url: string): string {
  return url.trim();
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationProxyMode;
};

export type BrowserNavigationProxyMode =
  | "direct"
  | "explicit-browser-proxy"
  | "external-browser-proxy";

export type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
  opts?: { browserProxyMode?: BrowserNavigationProxyMode },
): BrowserNavigationPolicyOptions {
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(opts?.browserProxyMode && opts.browserProxyMode !== "direct"
      ? { browserProxyMode: opts.browserProxyMode }
      : {}),
  };
}

export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean {
  return ssrfPolicy?.dangerouslyAllowPrivateNetwork === false;
}

export function requiresInspectableBrowserNavigationRedirectsForUrl(
  url: string,
  ssrfPolicy?: SsrFPolicy,
): boolean {
  if (!requiresInspectableBrowserNavigationRedirects(ssrfPolicy)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isIpLiteralHostname(hostname: string): boolean {
  return isIP(normalizeHostname(hostname)) !== 0;
}

function isExplicitlyAllowedBrowserHostname(hostname: string, ssrfPolicy?: SsrFPolicy): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const exactMatches = ssrfPolicy?.allowedHostnames ?? [];
  if (exactMatches.some((value) => normalizeHostname(value) === normalizedHostname)) {
    return true;
  }
  const hostnameAllowlist = (ssrfPolicy?.hostnameAllowlist ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter(Boolean);
  return hostnameAllowlist.length > 0
    ? matchesHostnameAllowlist(normalizedHostname, hostnameAllowlist)
    : false;
}

export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = normalizeNavigationUrl(opts.url);
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  // The browser profile manages its own network stack (e.g. `existing-session`
  // drivers inherit the host browser's proxy/PAC/VPN configuration). Node-side
  // `getaddrinfo` does not observe where the browser will actually connect —
  // for example, a split-tunnel VPN can resolve a public hostname to its own
  // loopback proxy IP on the gateway host, while the browser sends the request
  // through the VPN to the real public target. DNS-to-IP SSRF checks are not
  // meaningful in this configuration. Keep the hostname denylist so cloud
  // metadata services (`metadata.google.internal`), loopback aliases
  // (`localhost`), and reserved TLDs (`*.local`, `*.internal`, `*.localhost`)
  // are still rejected as defense-in-depth.
  if (opts.browserProxyMode === "external-browser-proxy") {
    if (isBlockedHostnameOrIp(parsed.hostname)) {
      throw new SsrFBlockedError(`Blocked hostname: ${parsed.hostname}`);
    }
    return;
  }

  // Browser proxy routing hides the final connect target from this process.
  // Only block when the browser profile is known to be proxy-routed; Gateway
  // provider proxy env alone is not proof of browser page proxy behavior.
  if (
    opts.browserProxyMode === "explicit-browser-proxy" &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed",
    );
  }

  // Browser navigations happen in Chromium's network stack, not Node's. In
  // strict mode, a hostname-based URL would be resolved twice by different
  // resolvers, so Node-side pinning cannot guarantee the browser connects to
  // the same address that passed policy checks.
  if (
    opts.ssrfPolicy &&
    opts.ssrfPolicy.dangerouslyAllowPrivateNetwork === false &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) &&
    !isIpLiteralHostname(parsed.hostname) &&
    !isExplicitlyAllowedBrowserHostname(parsed.hostname, opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy requires an IP-literal URL because browser DNS rebinding protections are unavailable for hostname-based navigation",
    );
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://). In strict
 * mode this intentionally re-applies the hostname gate after redirects.
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = normalizeNavigationUrl(opts.url);
  if (!rawUrl) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) ||
    isAllowedNonNetworkNavigationUrl(parsed)
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}

export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const url of chain.toReversed()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
    });
  }
}
