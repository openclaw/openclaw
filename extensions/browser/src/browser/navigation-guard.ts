import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import {
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // Keep non-network navigation explicit; about:blank is the only allowed bootstrap URL.
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
};

export type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

export type BrowserNavigationRouteLike = {
  abort(): Promise<void> | void;
  continue(): Promise<void> | void;
};

export type BrowserNavigationInterceptRequestLike = {
  url(): string;
  isNavigationRequest?(): boolean;
  frame?(): {
    parentFrame?(): unknown;
  } | null;
};

export type BrowserNavigationRouteInstallerLike = {
  route(
    matcher: string,
    handler: (
      route: BrowserNavigationRouteLike,
      request: BrowserNavigationInterceptRequestLike,
    ) => Promise<void> | void,
  ): Promise<void> | void;
  unroute(
    matcher: string,
    handler: (
      route: BrowserNavigationRouteLike,
      request: BrowserNavigationInterceptRequestLike,
    ) => Promise<void> | void,
  ): Promise<void> | void;
};

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {};
}

export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean {
  return !isPrivateNetworkAllowedByPolicy(ssrfPolicy);
}

export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
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

  // Browser network stacks may apply env proxy routing at connect-time, which
  // can bypass strict destination-binding intent from pre-navigation DNS checks.
  // In strict mode, fail closed unless private-network navigation is explicitly
  // enabled by policy.
  if (hasProxyEnvConfigured() && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while env proxy variables are set",
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
 * positives on browser-internal error pages (e.g. chrome-error://).
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
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
    });
  }
}

function isMainFrameNavigationRequest(request: BrowserNavigationInterceptRequestLike): boolean {
  if (request.isNavigationRequest?.() !== true) {
    return false;
  }
  const frame = request.frame?.();
  return frame?.parentFrame?.() == null;
}

export async function withRequestTimeBrowserNavigationGuard<T>(
  opts: {
    page: BrowserNavigationRouteInstallerLike;
    navigate: () => Promise<T>;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  let blockedError: unknown;
  const handler = async (
    route: BrowserNavigationRouteLike,
    request: BrowserNavigationInterceptRequestLike,
  ) => {
    if (!isMainFrameNavigationRequest(request)) {
      await route.continue();
      return;
    }
    try {
      await assertBrowserNavigationAllowed({
        url: request.url(),
        lookupFn: opts.lookupFn,
        ssrfPolicy: opts.ssrfPolicy,
      });
      await route.continue();
    } catch (err) {
      // Record the policy error before awaiting route.abort() so callers still see the
      // SSRF/URL failure even if navigate() resolves once Playwright aborts the request.
      blockedError = err;
      await route.abort();
    }
  };

  await opts.page.route("**/*", handler);
  try {
    const result = await opts.navigate();
    if (blockedError) {
      throw blockedError;
    }
    return result;
  } catch (err) {
    throw blockedError ?? err;
  } finally {
    await opts.page.unroute("**/*", handler).catch(() => {});
  }
}
