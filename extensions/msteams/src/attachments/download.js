import { getMSTeamsRuntime } from "../runtime.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  extractInlineImageCandidates,
  inferPlaceholder,
  isDownloadableAttachment,
  isRecord,
  isUrlAllowed,
  normalizeContentType,
  resolveMediaSsrfPolicy,
  resolveAttachmentFetchPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy
} from "./shared.js";
function resolveDownloadCandidate(att) {
  const contentType = normalizeContentType(att.contentType);
  const name = typeof att.name === "string" ? att.name.trim() : "";
  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) {
      return null;
    }
    const downloadUrl = typeof att.content.downloadUrl === "string" ? att.content.downloadUrl.trim() : "";
    if (!downloadUrl) {
      return null;
    }
    const fileType = typeof att.content.fileType === "string" ? att.content.fileType.trim() : "";
    const uniqueId = typeof att.content.uniqueId === "string" ? att.content.uniqueId.trim() : "";
    const fileName = typeof att.content.fileName === "string" ? att.content.fileName.trim() : "";
    const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
    return {
      url: downloadUrl,
      fileHint: fileHint || void 0,
      contentTypeHint: void 0,
      placeholder: inferPlaceholder({
        contentType,
        fileName: fileHint,
        fileType
      })
    };
  }
  const contentUrl = typeof att.contentUrl === "string" ? att.contentUrl.trim() : "";
  if (!contentUrl) {
    return null;
  }
  return {
    url: contentUrl,
    fileHint: name || void 0,
    contentTypeHint: contentType,
    placeholder: inferPlaceholder({ contentType, fileName: name })
  };
}
function scopeCandidatesForUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const looksLikeGraph = host.endsWith("graph.microsoft.com") || host.endsWith("sharepoint.com") || host.endsWith("1drv.ms") || host.includes("sharepoint");
    return looksLikeGraph ? ["https://graph.microsoft.com", "https://api.botframework.com"] : ["https://api.botframework.com", "https://graph.microsoft.com"];
  } catch {
    return ["https://api.botframework.com", "https://graph.microsoft.com"];
  }
}
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
async function fetchWithAuthFallback(params) {
  const firstAttempt = await safeFetchWithPolicy({
    url: params.url,
    policy: params.policy,
    fetchFn: params.fetchFn,
    requestInit: params.requestInit
  });
  if (firstAttempt.ok) {
    return firstAttempt;
  }
  if (!params.tokenProvider) {
    return firstAttempt;
  }
  if (firstAttempt.status !== 401 && firstAttempt.status !== 403) {
    return firstAttempt;
  }
  if (!isUrlAllowed(params.url, params.policy.authAllowHosts)) {
    return firstAttempt;
  }
  const scopes = scopeCandidatesForUrl(params.url);
  const fetchFn = params.fetchFn ?? fetch;
  for (const scope of scopes) {
    try {
      const token = await params.tokenProvider.getAccessToken(scope);
      const authHeaders = new Headers(params.requestInit?.headers);
      authHeaders.set("Authorization", `Bearer ${token}`);
      const authAttempt = await safeFetchWithPolicy({
        url: params.url,
        policy: params.policy,
        fetchFn,
        requestInit: {
          ...params.requestInit,
          headers: authHeaders
        }
      });
      if (authAttempt.ok) {
        return authAttempt;
      }
      if (isRedirectStatus(authAttempt.status)) {
        return authAttempt;
      }
      if (authAttempt.status !== 401 && authAttempt.status !== 403) {
        continue;
      }
    } catch {
    }
  }
  return firstAttempt;
}
async function downloadMSTeamsAttachments(params) {
  const list = Array.isArray(params.attachments) ? params.attachments : [];
  if (list.length === 0) {
    return [];
  }
  const policy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts
  });
  const allowHosts = policy.allowHosts;
  const ssrfPolicy = resolveMediaSsrfPolicy(allowHosts);
  const downloadable = list.filter(isDownloadableAttachment);
  const candidates = downloadable.map(resolveDownloadCandidate).filter(Boolean);
  const inlineCandidates = extractInlineImageCandidates(list);
  const seenUrls = /* @__PURE__ */ new Set();
  for (const inline of inlineCandidates) {
    if (inline.kind === "url") {
      if (!isUrlAllowed(inline.url, allowHosts)) {
        continue;
      }
      if (seenUrls.has(inline.url)) {
        continue;
      }
      seenUrls.add(inline.url);
      candidates.push({
        url: inline.url,
        fileHint: inline.fileHint,
        contentTypeHint: inline.contentType,
        placeholder: inline.placeholder
      });
    }
  }
  if (candidates.length === 0 && inlineCandidates.length === 0) {
    return [];
  }
  const out = [];
  for (const inline of inlineCandidates) {
    if (inline.kind !== "data") {
      continue;
    }
    if (inline.data.byteLength > params.maxBytes) {
      continue;
    }
    try {
      const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
        inline.data,
        inline.contentType,
        "inbound",
        params.maxBytes
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inline.placeholder
      });
    } catch {
    }
  }
  for (const candidate of candidates) {
    if (!isUrlAllowed(candidate.url, allowHosts)) {
      continue;
    }
    try {
      const media = await downloadAndStoreMSTeamsRemoteMedia({
        url: candidate.url,
        filePathHint: candidate.fileHint ?? candidate.url,
        maxBytes: params.maxBytes,
        contentTypeHint: candidate.contentTypeHint,
        placeholder: candidate.placeholder,
        preserveFilenames: params.preserveFilenames,
        ssrfPolicy,
        fetchImpl: (input, init) => fetchWithAuthFallback({
          url: resolveRequestUrl(input),
          tokenProvider: params.tokenProvider,
          fetchFn: params.fetchFn,
          requestInit: init,
          policy
        })
      });
      out.push(media);
    } catch {
    }
  }
  return out;
}
const downloadMSTeamsImageAttachments = downloadMSTeamsAttachments;
export {
  downloadMSTeamsAttachments,
  downloadMSTeamsImageAttachments
};
