import { Buffer } from "node:buffer";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist as resolveMediaSsrfPolicy,
  isHttpsUrlAllowedByHostnameSuffixAllowlist as isUrlAllowed,
  normalizeHostnameSuffixAllowlist,
} from "openclaw/plugin-sdk/ssrf-policy";
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { GRAPH_HOSTS, SHAREPOINT_HOSTS } from "../microsoft-hosts.js";
import type { MSTeamsMonitorLogger } from "../monitor-types.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "../request-timeout.js";
import type { MSTeamsAttachmentLike, MSTeamsInboundMedia } from "./types.js";

type InlineImageReference =
  | {
      kind: "data";
      src: string;
      sourceId?: string;
    }
  | {
      kind: "url";
      url: string;
      contentType?: string;
      fileHint?: string;
      sourceId?: string;
    }
  | { kind: "unavailable"; sourceId?: string };

const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

/**
 * Values of `attr` on each `<tag ...>` in document order, matching the captures of
 * `/<tag[^>]+attr=["']([^"']+)["'][^>]*>/gi`: the last attribute spelling inside the
 * tag wins, and a quoted value may contain `>`. Each `<tag` start is resolved from
 * precomputed next-`>` and next-quote positions in one forward pass.
 */
export function htmlTagAttributeValues(
  html: string,
  tag: "img" | "attachment",
  attr: "src" | "id",
  visit?: (value: string, start: number, end: number) => void,
): string[] {
  const length = html.length;
  const nextGt = new Int32Array(length + 1).fill(length);
  const nextQuote = new Int32Array(length + 1).fill(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = html[index];
    nextGt[index] = char === ">" ? index : nextGt[index + 1]!;
    nextQuote[index] = char === '"' || char === "'" ? index : nextQuote[index + 1]!;
  }
  // An attribute spelling is usable when a non-empty value, a closing quote and a
  // later `>` follow it, whichever tag it ends up inside.
  const candidates: Array<{ start: number; valueStart: number; valueEnd: number; end: number }> =
    [];
  for (const match of html.matchAll(new RegExp(`${attr}=["']`, "gi"))) {
    const valueStart = match.index + match[0].length;
    const valueEnd = nextQuote[valueStart]!;
    if (valueEnd > valueStart && valueEnd < length && nextGt[valueEnd + 1]! < length) {
      candidates.push({ start: match.index, valueStart, valueEnd, end: nextGt[valueEnd + 1]! + 1 });
    }
  }
  const values: string[] = [];
  let resumeAt = 0;
  let pastWindow = 0;
  for (const open of html.matchAll(new RegExp(`<${tag}`, "gi"))) {
    if (open.index < resumeAt) {
      continue;
    }
    // The attribute starts at least one character after the tag name (`[^>]+` is
    // non-empty) and no later than the first `>`, so the window only moves forward.
    const nameEnd = open.index + open[0].length;
    const lastStart = nextGt[nameEnd]!;
    while (pastWindow < candidates.length && candidates[pastWindow]!.start <= lastStart) {
      pastWindow += 1;
    }
    const candidate = candidates[pastWindow - 1];
    if (candidate && candidate.start > nameEnd) {
      const value = html.slice(candidate.valueStart, candidate.valueEnd);
      if (visit) {
        visit(value, open.index, candidate.end);
      } else {
        values.push(value);
      }
      resumeAt = candidate.end;
    }
  }
  return values;
}
const GRAPH_HOSTED_CONTENT_SRC_RE = /\/hostedContents\/([^/?#]+)/i;

// Teams emoji sprites are text; require the CDN host plus an emoji path or alt
// marker so genuine images on the same CDN remain media.
const TEAMS_EMOJI_CDN_HOST = "statics.teams.cdn.office.net";
const TEAMS_EMOJI_ASSET_PATH_RE = /\/emoji([/?#]|$)/i;
const IMG_ALT_ATTR_RE = /\balt=["']([^"']*)["']/i;
const EMOJI_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

function isTeamsEmojiSpriteImage(src: string, imgTag: string): boolean {
  const url = URL.parse(src);
  const host = url?.hostname.toLowerCase() ?? "";
  if (host !== TEAMS_EMOJI_CDN_HOST && !host.endsWith(`.${TEAMS_EMOJI_CDN_HOST}`)) {
    return false;
  }
  return (
    TEAMS_EMOJI_ASSET_PATH_RE.test(url?.pathname ?? "") ||
    EMOJI_PICTOGRAPHIC_RE.test(IMG_ALT_ATTR_RE.exec(imgTag)?.[1] ?? "")
  );
}

// Preserve sprite text before HTML stripping, including HTML-only emoji messages.
export function replaceTeamsEmojiSpriteImagesWithAltText(html: string): string {
  const parts: string[] = [];
  let cursor = 0;
  htmlTagAttributeValues(html, "img", "src", (src, start, end) => {
    const imgTag = html.slice(start, end);
    if (isTeamsEmojiSpriteImage(src.trim(), imgTag)) {
      parts.push(html.slice(cursor, start), IMG_ALT_ATTR_RE.exec(imgTag)?.[1] ?? "");
      cursor = end;
    }
  });
  return parts.join("") + html.slice(cursor);
}

function resolveInlineImageSourceId(src: string): string {
  // Graph fallback names hosted content by item ID, while activity HTML carries its `$value` URL.
  // Normalize both paths to one identity so a recovered image replaces its advertised slot.
  const hostedContentId = GRAPH_HOSTED_CONTENT_SRC_RE.exec(src)?.[1];
  if (!hostedContentId) {
    return src;
  }
  try {
    return decodeURIComponent(hostedContentId);
  } catch {
    return hostedContentId;
  }
}

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

export function normalizeContentType(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  // RFC 2045 makes the media type case-insensitive, but parameter values may
  // remain case-sensitive, so normalize only the type before the first `;`.
  const parameterIndex = trimmed.indexOf(";");
  if (parameterIndex === -1) {
    return trimmed.toLowerCase();
  }
  return `${trimmed.slice(0, parameterIndex).trim().toLowerCase()}${trimmed.slice(parameterIndex)}`;
}

export function resolveMSTeamsMediaKind(params: {
  contentType?: string;
  fileName?: string;
  fileType?: string;
}): MSTeamsInboundMedia["kind"] {
  const mime = normalizeLowercaseStringOrEmpty(params.contentType);
  const name = normalizeLowercaseStringOrEmpty(params.fileName);
  const fileType = normalizeLowercaseStringOrEmpty(params.fileType);

  const looksLikeImage =
    mime.startsWith("image/") || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(`x.${fileType}`);

  return looksLikeImage ? "image" : "document";
}

export function isLikelyImageAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  const name = typeof att.name === "string" ? att.name : "";
  if (contentType.startsWith("image/")) {
    return true;
  }
  if (IMAGE_EXT_RE.test(name)) {
    return true;
  }

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content)
  ) {
    const fileType = typeof att.content.fileType === "string" ? att.content.fileType : "";
    if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) {
      return true;
    }
    const fileName = typeof att.content.fileName === "string" ? att.content.fileName : "";
    if (fileName && IMAGE_EXT_RE.test(fileName)) {
      return true;
    }
  }

  return false;
}

export function isDownloadableAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content) &&
    typeof att.content.downloadUrl === "string"
  ) {
    return true;
  }

  return typeof att.contentUrl === "string" && Boolean(att.contentUrl.trim());
}

export function isAdvertisedFileAttachment(attachment: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(attachment.contentType) ?? "";
  if (
    contentType.startsWith("text/html") ||
    contentType.startsWith("application/vnd.microsoft.card.") ||
    contentType.startsWith("application/vnd.microsoft.teams.card.")
  ) {
    return false;
  }
  return Boolean(
    isDownloadableAttachment(attachment) ||
    isLikelyImageAttachment(attachment) ||
    attachment.name?.trim() ||
    contentType,
  );
}

export function extractHtmlFromAttachment(att: MSTeamsAttachmentLike): string | undefined {
  if (!normalizeContentType(att.contentType)?.startsWith("text/html")) {
    return undefined;
  }
  if (typeof att.content === "string") {
    return att.content;
  }
  if (!isRecord(att.content)) {
    return undefined;
  }
  return typeof att.content.text === "string"
    ? att.content.text
    : typeof att.content.body === "string"
      ? att.content.body
      : typeof att.content.content === "string"
        ? att.content.content
        : undefined;
}

function fileHintFromUrl(src: string): string | undefined {
  return URL.parse(src)?.pathname.split("/").pop() || undefined;
}

export function extractInlineImageReferences(
  attachments: MSTeamsAttachmentLike[],
): InlineImageReference[] {
  const out: InlineImageReference[] = [];
  const seenReferences = new Set<string>();
  const representedAttachmentIds = new Set(
    attachments.flatMap((attachment) => {
      const id = attachment.id?.trim();
      return id && !extractHtmlFromAttachment(attachment) ? [id] : [];
    }),
  );
  for (const att of attachments) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    for (const value of htmlTagAttributeValues(
      replaceTeamsEmojiSpriteImagesWithAltText(html),
      "img",
      "src",
    )) {
      const src = value.trim();
      if (src) {
        if (src.startsWith("data:")) {
          out.push({ kind: "data", src });
        } else if (!seenReferences.has(src)) {
          seenReferences.add(src);
          if (src.startsWith("cid:")) {
            const sourceId = src.slice("cid:".length) || undefined;
            if (!sourceId || !representedAttachmentIds.has(sourceId)) {
              out.push({ kind: "unavailable", sourceId });
            }
            continue;
          }
          out.push({
            kind: "url",
            url: src,
            fileHint: fileHintFromUrl(src),
            sourceId: resolveInlineImageSourceId(src),
          });
        }
      }
    }
  }
  return out;
}

export function safeHostForUrl(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? normalizeLowercaseStringOrEmpty(parsed.hostname) : "invalid-url";
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
