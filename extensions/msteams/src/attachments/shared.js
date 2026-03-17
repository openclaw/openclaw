import { lookup } from "node:dns/promises";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  isPrivateIpAddress,
  normalizeHostnameSuffixAllowlist
} from "openclaw/plugin-sdk/msteams";
const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const ATTACHMENT_TAG_RE = /<attachment[^>]+id=["']([^"']+)["'][^>]*>/gi;
const DEFAULT_MEDIA_HOST_ALLOWLIST = [
  "graph.microsoft.com",
  "graph.microsoft.us",
  "graph.microsoft.de",
  "graph.microsoft.cn",
  "sharepoint.com",
  "sharepoint.us",
  "sharepoint.de",
  "sharepoint.cn",
  "sharepoint-df.com",
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
  "blob.core.windows.net",
  "azureedge.net",
  "microsoft.com"
];
const DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST = [
  "api.botframework.com",
  "botframework.com",
  "graph.microsoft.com",
  "graph.microsoft.us",
  "graph.microsoft.de",
  "graph.microsoft.cn"
];
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function resolveRequestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  return String(input);
}
function normalizeContentType(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : void 0;
}
function inferPlaceholder(params) {
  const mime = params.contentType?.toLowerCase() ?? "";
  const name = params.fileName?.toLowerCase() ?? "";
  const fileType = params.fileType?.toLowerCase() ?? "";
  const looksLikeImage = mime.startsWith("image/") || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(`x.${fileType}`);
  return looksLikeImage ? "<media:image>" : "<media:document>";
}
function isLikelyImageAttachment(att) {
  const contentType = normalizeContentType(att.contentType) ?? "";
  const name = typeof att.name === "string" ? att.name : "";
  if (contentType.startsWith("image/")) {
    return true;
  }
  if (IMAGE_EXT_RE.test(name)) {
    return true;
  }
  if (contentType === "application/vnd.microsoft.teams.file.download.info" && isRecord(att.content)) {
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
function isDownloadableAttachment(att) {
  const contentType = normalizeContentType(att.contentType) ?? "";
  if (contentType === "application/vnd.microsoft.teams.file.download.info" && isRecord(att.content) && typeof att.content.downloadUrl === "string") {
    return true;
  }
  if (typeof att.contentUrl === "string" && att.contentUrl.trim()) {
    return true;
  }
  return false;
}
function isHtmlAttachment(att) {
  const contentType = normalizeContentType(att.contentType) ?? "";
  return contentType.startsWith("text/html");
}
function extractHtmlFromAttachment(att) {
  if (!isHtmlAttachment(att)) {
    return void 0;
  }
  if (typeof att.content === "string") {
    return att.content;
  }
  if (!isRecord(att.content)) {
    return void 0;
  }
  const text = typeof att.content.text === "string" ? att.content.text : typeof att.content.body === "string" ? att.content.body : typeof att.content.content === "string" ? att.content.content : void 0;
  return text;
}
function decodeDataImage(src) {
  const match = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,(.*)$/i.exec(src);
  if (!match) {
    return null;
  }
  const contentType = match[1]?.toLowerCase();
  const isBase64 = Boolean(match[2]);
  if (!isBase64) {
    return null;
  }
  const payload = match[3] ?? "";
  if (!payload) {
    return null;
  }
  try {
    const data = Buffer.from(payload, "base64");
    return { kind: "data", data, contentType, placeholder: "<media:image>" };
  } catch {
    return null;
  }
}
function fileHintFromUrl(src) {
  try {
    const url = new URL(src);
    const name = url.pathname.split("/").pop();
    return name || void 0;
  } catch {
    return void 0;
  }
}
function extractInlineImageCandidates(attachments) {
  const out = [];
  for (const att of attachments) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    IMG_SRC_RE.lastIndex = 0;
    let match = IMG_SRC_RE.exec(html);
    while (match) {
      const src = match[1]?.trim();
      if (src && !src.startsWith("cid:")) {
        if (src.startsWith("data:")) {
          const decoded = decodeDataImage(src);
          if (decoded) {
            out.push(decoded);
          }
        } else {
          out.push({
            kind: "url",
            url: src,
            fileHint: fileHintFromUrl(src),
            placeholder: "<media:image>"
          });
        }
      }
      match = IMG_SRC_RE.exec(html);
    }
  }
  return out;
}
function safeHostForUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "invalid-url";
  }
}
function resolveAllowedHosts(input) {
  return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_HOST_ALLOWLIST);
}
function resolveAuthAllowedHosts(input) {
  return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST);
}
function resolveAttachmentFetchPolicy(params) {
  return {
    allowHosts: resolveAllowedHosts(params?.allowHosts),
    authAllowHosts: resolveAuthAllowedHosts(params?.authAllowHosts)
  };
}
function isUrlAllowed(url, allowlist) {
  return isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist);
}
function applyAuthorizationHeaderForUrl(params) {
  if (!params.bearerToken) {
    params.headers.delete("Authorization");
    return;
  }
  if (isUrlAllowed(params.url, params.authAllowHosts)) {
    params.headers.set("Authorization", `Bearer ${params.bearerToken}`);
    return;
  }
  params.headers.delete("Authorization");
}
function resolveMediaSsrfPolicy(allowHosts) {
  return buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts);
}
const isPrivateOrReservedIP = isPrivateIpAddress;
async function resolveAndValidateIP(hostname, resolveFn) {
  const resolve = resolveFn ?? lookup;
  let resolved;
  try {
    resolved = await resolve(hostname);
  } catch {
    throw new Error(`DNS resolution failed for "${hostname}"`);
  }
  if (isPrivateOrReservedIP(resolved.address)) {
    throw new Error(`Hostname "${hostname}" resolves to private/reserved IP (${resolved.address})`);
  }
  return resolved.address;
}
const MAX_SAFE_REDIRECTS = 5;
async function safeFetch(params) {
  const fetchFn = params.fetchFn ?? fetch;
  const resolveFn = params.resolveFn;
  const hasDispatcher = Boolean(
    params.requestInit && typeof params.requestInit === "object" && "dispatcher" in params.requestInit
  );
  const currentHeaders = new Headers(params.requestInit?.headers);
  let currentUrl = params.url;
  if (!isUrlAllowed(currentUrl, params.allowHosts)) {
    throw new Error(`Initial download URL blocked: ${currentUrl}`);
  }
  if (resolveFn) {
    try {
      const initialHost = new URL(currentUrl).hostname;
      await resolveAndValidateIP(initialHost, resolveFn);
    } catch {
      throw new Error(`Initial download URL blocked: ${currentUrl}`);
    }
  }
  for (let i = 0; i <= MAX_SAFE_REDIRECTS; i++) {
    const res = await fetchFn(currentUrl, {
      ...params.requestInit,
      headers: currentHeaders,
      redirect: "manual"
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) {
      return res;
    }
    const location = res.headers.get("location");
    if (!location) {
      return res;
    }
    let redirectUrl;
    try {
      redirectUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`Invalid redirect URL: ${location}`);
    }
    if (!isUrlAllowed(redirectUrl, params.allowHosts)) {
      throw new Error(`Media redirect target blocked by allowlist: ${redirectUrl}`);
    }
    if (currentHeaders.has("authorization") && params.authorizationAllowHosts && !isUrlAllowed(redirectUrl, params.authorizationAllowHosts)) {
      currentHeaders.delete("authorization");
    }
    if (hasDispatcher) {
      return res;
    }
    if (resolveFn) {
      const redirectHost = new URL(redirectUrl).hostname;
      await resolveAndValidateIP(redirectHost, resolveFn);
    }
    currentUrl = redirectUrl;
  }
  throw new Error(`Too many redirects (>${MAX_SAFE_REDIRECTS})`);
}
async function safeFetchWithPolicy(params) {
  return await safeFetch({
    url: params.url,
    allowHosts: params.policy.allowHosts,
    authorizationAllowHosts: params.policy.authAllowHosts,
    fetchFn: params.fetchFn,
    requestInit: params.requestInit,
    resolveFn: params.resolveFn
  });
}
export {
  ATTACHMENT_TAG_RE,
  DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST,
  DEFAULT_MEDIA_HOST_ALLOWLIST,
  GRAPH_ROOT,
  IMAGE_EXT_RE,
  IMG_SRC_RE,
  applyAuthorizationHeaderForUrl,
  extractHtmlFromAttachment,
  extractInlineImageCandidates,
  inferPlaceholder,
  isDownloadableAttachment,
  isLikelyImageAttachment,
  isPrivateOrReservedIP,
  isRecord,
  isUrlAllowed,
  normalizeContentType,
  resolveAllowedHosts,
  resolveAndValidateIP,
  resolveAttachmentFetchPolicy,
  resolveAuthAllowedHosts,
  resolveMediaSsrfPolicy,
  resolveRequestUrl,
  safeFetch,
  safeFetchWithPolicy,
  safeHostForUrl
};
