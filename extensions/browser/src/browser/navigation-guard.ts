/**
 * Browser navigation SSRF guard.
 *
 * Validates page navigation URLs and redirect chains before or after browser
 * navigation while accounting for browser proxy routing.
 */
import { isIP } from "node:net";
import {
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import { matchesHostnameAllowlist, normalizeHostname } from "../sdk-security-runtime.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
const LOCAL_FILE_NAVIGATION_HOSTNAMES = new Set(["", "localhost"]);
const INERT_LOCAL_FILE_NAVIGATION_EXTENSIONS = new Set([
  ".csv",
  ".gif",
  ".jpeg",
  ".jpg",
  ".json",
  ".jsonl",
  ".log",
  ".markdown",
  ".md",
  ".png",
  ".txt",
  ".tsv",
  ".webp",
]);

function isAllowedLocalFileNavigationUrl(parsed: URL): boolean {
  if (parsed.protocol !== "file:") {
    return false;
  }
  if (!LOCAL_FILE_NAVIGATION_HOSTNAMES.has(normalizeHostname(parsed.hostname))) {
    return false;
  }
  const pathname = parsed.pathname.toLowerCase();
  return Array.from(INERT_LOCAL_FILE_NAVIGATION_EXTENSIONS).some((extension) =>
    pathname.endsWith(extension),
  );
}

function isAllowedNonNetworkNavigationUrl(
  parsed: URL,
  opts?: { allowLocalFileNavigation?: boolean },
): boolean {
  if (SAFE_NON_NETWORK_URLS.has(parsed.href)) {
    return true;
  }
  return opts?.allowLocalFileNavigation === true && isAllowedLocalFileNavigationUrl(parsed);
}

function normalizeNavigationUrl(url: string): string {
  return url.trim();
}

/** Return true when two navigation URL strings resolve to the same browser target. */
export function isSameBrowserNavigationUrl(left: string, right: string): boolean {
  try {
    return (
      new URL(normalizeNavigationUrl(left)).href === new URL(normalizeNavigationUrl(right)).href
    );
  } catch {
    return false;
  }
}

/** Raised when a browser navigation URL fails syntax or policy validation. */
export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

/** Policy inputs applied to browser page navigation checks. */
export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationProxyMode;
  allowLocalFileNavigation?: boolean;
};

/** Describes whether the browser itself is routing page traffic through a proxy. */
export type BrowserNavigationProxyMode = "direct" | "explicit-browser-proxy";

/** Minimal request shape used to walk browser redirect chains. */
export type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

/** Build a navigation-policy object while omitting default direct proxy mode. */
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

/** Return true when strict policy requires redirect-chain inspection. */
export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean {
  return ssrfPolicy?.dangerouslyAllowPrivateNetwork === false;
}

/** Return true when a URL needs redirect inspection under strict policy. */
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

/** Assert that a requested browser navigation URL is policy-allowed. */
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
    if (
      isAllowedNonNetworkNavigationUrl(parsed, {
        allowLocalFileNavigation: opts.allowLocalFileNavigation,
      })
    ) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
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
    SAFE_NON_NETWORK_URLS.has(parsed.href) ||
    parsed.protocol === "file:"
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}

/** Assert that every URL in a browser redirect chain is policy-allowed. */
export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    initialUrl?: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const [index, url] of chain.toReversed().entries()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      allowLocalFileNavigation:
        index === 0 && opts.initialUrl ? isSameBrowserNavigationUrl(url, opts.initialUrl) : false,
    });
  }
}
