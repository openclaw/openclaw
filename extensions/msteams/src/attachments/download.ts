import { getMSTeamsRuntime } from "../runtime.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  extractInlineImageCandidates,
  inferPlaceholder,
  isDownloadableAttachment,
  isRecord,
  isUrlAllowed,
  type MSTeamsAttachmentFetchPolicy,
  normalizeContentType,
  resolveMediaSsrfPolicy,
  resolveAttachmentFetchPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsInboundMedia,
} from "./types.js";

type DownloadCandidate = {
  url: string;
  fileHint?: string;
  contentTypeHint?: string;
  placeholder: string;
};

function resolveDownloadCandidate(att: MSTeamsAttachmentLike): DownloadCandidate | null {
  const contentType = normalizeContentType(att.contentType);
  const name = typeof att.name === "string" ? att.name.trim() : "";

  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) {
      return null;
    }
    const downloadUrl =
      typeof att.content.downloadUrl === "string" ? att.content.downloadUrl.trim() : "";
    if (!downloadUrl) {
      return null;
    }

    const fileType = typeof att.content.fileType === "string" ? att.content.fileType.trim() : "";
    const uniqueId = typeof att.content.uniqueId === "string" ? att.content.uniqueId.trim() : "";
    const fileName = typeof att.content.fileName === "string" ? att.content.fileName.trim() : "";

    const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
    return {
      url: downloadUrl,
      fileHint: fileHint || undefined,
      contentTypeHint: undefined,
      placeholder: inferPlaceholder({
        contentType,
        fileName: fileHint,
        fileType,
      }),
    };
  }

  const contentUrl = typeof att.contentUrl === "string" ? att.contentUrl.trim() : "";
  if (!contentUrl) {
    return null;
  }

  return {
    url: contentUrl,
    fileHint: name || undefined,
    contentTypeHint: contentType,
    placeholder: inferPlaceholder({ contentType, fileName: name }),
  };
}

function scopeCandidatesForUrl(url: string): string[] {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const looksLikeGraph =
      host.endsWith("graph.microsoft.com") ||
      host.endsWith("sharepoint.com") ||
      host.endsWith("1drv.ms") ||
      host.includes("sharepoint");
    return looksLikeGraph
      ? ["https://graph.microsoft.com", "https://api.botframework.com"]
      : ["https://api.botframework.com", "https://graph.microsoft.com"];
  } catch {
    return ["https://api.botframework.com", "https://graph.microsoft.com"];
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithAuthFallback(params: {
  url: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
  requestInit?: RequestInit;
  policy: MSTeamsAttachmentFetchPolicy;
}): Promise<Response> {
  const firstAttempt = await safeFetchWithPolicy({
    url: params.url,
    policy: params.policy,
    fetchFn: params.fetchFn,
    requestInit: params.requestInit,
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
          headers: authHeaders,
        },
      });
      if (authAttempt.ok) {
        return authAttempt;
      }
      if (isRedirectStatus(authAttempt.status)) {
        // Redirects in guarded fetch mode must propagate to the outer guard.
        return authAttempt;
      }
      if (authAttempt.status !== 401 && authAttempt.status !== 403) {
        // Preserve scope fallback semantics for non-auth failures.
        continue;
      }
    } catch {
      // Try the next scope.
    }
  }

  return firstAttempt;
}

/**
 * Download all file attachments from a Teams message (images, documents, etc.).
 * Renamed from downloadMSTeamsImageAttachments to support all file types.
 */
export async function downloadMSTeamsAttachments(params: {
  attachments: MSTeamsAttachmentLike[] | undefined;
  maxBytes: number;
  tokenProvider?: MSTeamsAccessTokenProvider;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia[]> {
  const list = Array.isArray(params.attachments) ? params.attachments : [];
  if (list.length === 0) {
    return [];
  }
  const policy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const allowHosts = policy.allowHosts;
  const ssrfPolicy = resolveMediaSsrfPolicy(allowHosts);

  // Download ANY downloadable attachment (not just images)
  const downloadable = list.filter(isDownloadableAttachment);
  const candidates: DownloadCandidate[] = downloadable
    .map(resolveDownloadCandidate)
    .filter(Boolean) as DownloadCandidate[];

  const inlineCandidates = extractInlineImageCandidates(list, {
    maxInlineBytes: params.maxBytes,
    maxInlineTotalBytes: params.maxBytes,
  });

  const seenUrls = new Set<string>();
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
        placeholder: inline.placeholder,
      });
    }
  }
  if (candidates.length === 0 && inlineCandidates.length === 0) {
    return [];
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const inline of inlineCandidates) {
    if (inline.kind !== "data") {
      continue;
    }
    if (inline.data.byteLength > params.maxBytes) {
      continue;
    }
    try {
      // Data inline candidates (base64 data URLs) don't have original filenames
      const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
        inline.data,
        inline.contentType,
        "inbound",
        params.maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inline.placeholder,
      });
    } catch {
      // Ignore decode failures and continue.
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
        fetchImpl: (input, init) =>
          fetchWithAuthFallback({
            url: resolveRequestUrl(input),
            tokenProvider: params.tokenProvider,
            fetchFn: params.fetchFn,
            requestInit: init,
            policy,
          }),
      });
      out.push(media);
    } catch {
      // Ignore download failures and continue with next candidate.
    }
  }
  return out;
}

/**
 * @deprecated Use `downloadMSTeamsAttachments` instead (supports all file types).
 */
export const downloadMSTeamsImageAttachments = downloadMSTeamsAttachments;
