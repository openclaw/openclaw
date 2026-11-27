import { Buffer } from "node:buffer";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist as resolveMediaSsrfPolicy,
  isHttpsUrlAllowedByHostnameSuffixAllowlist as isUrlAllowed,
  normalizeHostnameSuffixAllowlist,
} from "openclaw/plugin-sdk/ssrf-policy";
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { GRAPH_HOSTS, SHAREPOINT_HOSTS } from "../microsoft-hosts.js";
import type { MSTeamsMonitorLogger } from "../monitor-types.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "../request-timeout.js";

const DEFAULT_MEDIA_HOST_ALLOWLIST = [
  ...GRAPH_HOSTS,
  ...SHAREPOINT_HOSTS,
  "1drv.ms",
  "onedrive.com",
  "teams.microsoft.com",
  "teams.cdn.office.net",
  "statics.teams.cdn.office.net",
  "office.com",
  "office.net",
  // Azure Media Services / Skype CDN for clipboard-pasted images
  "asm.skype.com",
  "ams.skype.com",
  "media.ams.skype.com",
  // Bot Framework attachment URLs
  "trafficmanager.net",
  "botframework.azure.cn",
  "blob.core.windows.net",
  "azureedge.net",
  "microsoft.com",
] as const;

const DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST = [
  "api.botframework.com",
  "botframework.com",
  // Bot Framework Service URL (smba.trafficmanager.net) used for outbound
  // replies and inbound attachment downloads (clipboard-pasted images).
  "smba.trafficmanager.net",
  "botframework.azure.cn",
  ...GRAPH_HOSTS,
] as const;

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/**
 * Host suffixes for SharePoint/OneDrive shared links that must be fetched via
 * the Graph `/shares/{shareId}/driveItem/content` endpoint instead of directly.
 *
 * Direct fetches of SharePoint/OneDrive shared URLs return empty/HTML landing
 * pages unless encoded as a Graph share id. See
 * https://learn.microsoft.com/en-us/graph/api/shares-get for the encoding.
 */
const GRAPH_SHARED_LINK_HOST_SUFFIXES = [
  ...SHAREPOINT_HOSTS.map((host) => `.${host}`),
  "1drv.ms",
  "onedrive.live.com",
  "onedrive.com",
] as const;

function isGraphSharedLinkUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed) {
    return false;
  }
  const host = normalizeLowercaseStringOrEmpty(parsed.hostname);
  if (parsed.protocol !== "https:" || !host) {
    return false;
  }
  // Only HTTPS URLs on a DNS label boundary may select the authenticated Graph path.
  return GRAPH_SHARED_LINK_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(suffix.startsWith(".") ? suffix : `.${suffix}`),
  );
}

/**
 * Encode a SharePoint/OneDrive URL as a Graph shareId using the documented
 * `u!` + base64url (no padding) scheme:
 * https://learn.microsoft.com/en-us/graph/api/shares-get#encoding-sharing-urls
 */
export function encodeGraphShareId(url: string): string {
  return `u!${Buffer.from(url, "utf8").toString("base64url")}`;
}

export function tryBuildGraphSharesUrlForSharedLink(url: string): string | undefined {
  if (!isGraphSharedLinkUrl(url)) {
    return undefined;
  }
  return `${GRAPH_ROOT}/shares/${encodeGraphShareId(url)}/driveItem/content`;
}

export type MSTeamsAttachmentFetchPolicy = {
  allowHosts: string[];
  authAllowHosts: string[];
};

export type MSTeamsAttachmentDownloadLogger = Partial<
  Pick<MSTeamsMonitorLogger, "debug" | "warn" | "error">
>;

function resolveRetainedAuthorizationRedirectHostnameAllowlist(
  input?: string[],
): string[] | undefined {
  if (!input) {
    return undefined;
  }
  if (input.includes("*")) {
    return ["*"];
  }
  return resolveMediaSsrfPolicy(input)?.hostnameAllowlist;
}

export function resolveAttachmentFetchPolicy(params?: {
  allowHosts?: string[];
  authAllowHosts?: string[];
}): MSTeamsAttachmentFetchPolicy {
  return {
    allowHosts: normalizeHostnameSuffixAllowlist(params?.allowHosts, DEFAULT_MEDIA_HOST_ALLOWLIST),
    authAllowHosts: normalizeHostnameSuffixAllowlist(
      params?.authAllowHosts,
      DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST,
    ),
  };
}

export function applyAuthorizationHeaderForUrl(params: {
  headers: Headers;
  url: string;
  authAllowHosts: string[];
  bearerToken?: string;
}): void {
  if (params.bearerToken && isUrlAllowed(params.url, params.authAllowHosts)) {
    params.headers.set("Authorization", `Bearer ${params.bearerToken}`);
  } else {
    params.headers.delete("Authorization");
  }
}

const MAX_SAFE_REDIRECTS = 5;
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch a URL with redirect: "manual", validating each redirect target
 * against the hostname allowlist and DNS-resolved IP (anti-SSRF).
 *
 * This prevents:
 * - Auto-following redirects to non-allowlisted hosts
 * - DNS rebinding attacks through the pinned DNS lookup
 */
export async function safeFetchWithPolicy(params: {
  url: string;
  policy: MSTeamsAttachmentFetchPolicy;
  resolveFn: (hostname: string) => Promise<{ address: string }>;
  requestInit?: RequestInit;
  timeoutMs?: number;
}): Promise<Response> {
  const { allowHosts, authAllowHosts } = params.policy;
  const currentHeaders = new Headers(params.requestInit?.headers);
  const currentUrl = params.url;

  if (!isUrlAllowed(currentUrl, allowHosts)) {
    throw new Error(`Initial download URL blocked: ${currentUrl}`);
  }

  // Authorization is only allowed on explicitly auth-allowlisted hosts, including
  // the first hop. Redirect hops apply the same rule in fetchWithSsrFGuard.
  if (currentHeaders.has("authorization") && !isUrlAllowed(currentUrl, authAllowHosts)) {
    currentHeaders.delete("authorization");
  }

  const lookupFn: LookupFn = async (hostname) => {
    const resolved = await params.resolveFn(hostname);
    return [{ ...resolved, family: resolved.address.includes(":") ? 6 : 4 }];
  };
  const guarded = await fetchWithSsrFGuard({
    url: currentUrl,
    init: {
      ...params.requestInit,
      headers: currentHeaders,
    },
    maxRedirects: MAX_SAFE_REDIRECTS,
    requireHttps: true,
    policy: resolveMediaSsrfPolicy(allowHosts),
    lookupFn,
    retainAuthorizationRedirectHostnameAllowlist:
      resolveRetainedAuthorizationRedirectHostnameAllowlist(authAllowHosts),
    auditContext: "msteams.attachment",
    timeoutMs: params.timeoutMs ?? MSTEAMS_REQUEST_TIMEOUT_MS,
  });
  return responseWithRelease(guarded.response, guarded.release);
}
