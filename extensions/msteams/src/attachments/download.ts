import { lookup } from "node:dns/promises";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { isHttpsUrlAllowedByHostnameSuffixAllowlist as isUrlAllowed } from "openclaw/plugin-sdk/ssrf-policy";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveMSTeamsRequestTimeoutMs,
  type MSTeamsRequestDeadline,
  withMSTeamsRequestDeadline,
} from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { ensureUserAgentHeader } from "../user-agent.js";
import { resolveUnrepresentedHtmlAttachmentIds } from "./html.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  applyAuthorizationHeaderForUrl,
  encodeGraphShareId,
  extractInlineImageReferences,
  GRAPH_ROOT,
  isAdvertisedFileAttachment,
  isDownloadableAttachment,
  isRedirectStatus,
  type MSTeamsAttachmentDownloadLogger,
  normalizeContentType,
  resolveMSTeamsMediaKind,
  resolveAttachmentFetchPolicy,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsInboundMedia,
} from "./types.js";

type DownloadCandidate =
  | {
      kind: "remote";
      mediaKind: MSTeamsInboundMedia["kind"];
      url: string;
      fileHint?: string;
      contentTypeHint?: string;
      sourceId?: string;
      graphReference?: boolean;
    }
  | {
      kind: "data";
      mediaKind: "image";
      src: string;
      sourceId?: string;
    }
  | { kind: "unavailable"; mediaKind: MSTeamsInboundMedia["kind"]; sourceId?: string };

function resolveDownloadCandidate(
  att: MSTeamsAttachmentLike,
  graphReferenceToken?: string,
): DownloadCandidate | null {
  const contentType = normalizeContentType(att.contentType);
  const graphReference = graphReferenceToken !== undefined && contentType === "reference";
  const name = normalizeOptionalString(att.name) ?? "";

  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) {
      return null;
    }
    const downloadUrl = normalizeOptionalString(att.content.downloadUrl) ?? "";
    if (!downloadUrl) {
      return null;
    }

    const fileType = normalizeOptionalString(att.content.fileType) ?? "";
    const uniqueId = normalizeOptionalString(att.content.uniqueId) ?? "";
    const fileName = normalizeOptionalString(att.content.fileName) ?? "";

    const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
    return {
      kind: "remote",
      mediaKind: resolveMSTeamsMediaKind({ contentType, fileName: fileHint, fileType }),
      url: downloadUrl,
      fileHint: fileHint || undefined,
      contentTypeHint: undefined,
      sourceId: att.id?.trim() || undefined,
    };
  }

  const contentUrl = graphReference
    ? (att.contentUrl ?? "")
    : (normalizeOptionalString(att.contentUrl) ?? "");
  if (!contentUrl) {
    return null;
  }

  // OneDrive/SharePoint shared links (delivered in 1:1 DMs when the user
  // picks "Attach > OneDrive") cannot be fetched directly — the URL returns
  // an HTML landing page rather than the file bytes. Rewrite them to the
  // Graph shares endpoint so the auth fallback attaches a Graph-scoped token
  // and the response is the real file content.
  const sharesUrl = graphReference
    ? `${GRAPH_ROOT}/shares/${encodeGraphShareId(contentUrl)}/driveItem/content`
    : tryBuildGraphSharesUrlForSharedLink(contentUrl);
  const resolvedUrl = sharesUrl ?? contentUrl;
  // Graph shares returns raw bytes without a declared content type we can
  // trust for routing — let the downloader infer MIME from the buffer.
  const resolvedContentTypeHint = graphReference
    ? "application/octet-stream"
    : sharesUrl
      ? undefined
      : contentType;

  return {
    kind: "remote",
    mediaKind: resolveMSTeamsMediaKind({ contentType, fileName: name }),
    url: resolvedUrl,
    fileHint: graphReference ? (att.name ?? undefined) : name || undefined,
    contentTypeHint: resolvedContentTypeHint,
    sourceId: att.id?.trim() || undefined,
    graphReference,
  };
}

function scopeCandidatesForUrl(url: string): string[] {
  const host = normalizeLowercaseStringOrEmpty(URL.parse(url)?.hostname);
  const looksLikeGraph =
    host.endsWith("graph.microsoft.com") ||
    host.endsWith("sharepoint.com") ||
    host.endsWith("1drv.ms") ||
    host.includes("sharepoint");
  return looksLikeGraph
    ? ["https://graph.microsoft.com", "https://api.botframework.com"]
    : ["https://api.botframework.com", "https://graph.microsoft.com"];
}

function canonicalizeInlineBase64Payload(value: string): string | undefined {
  let cleaned = "";
  for (const char of value) {
    if (char.charCodeAt(0) > 0x20) {
      cleaned += char;
    }
  }
  return cleaned.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) ? cleaned : undefined;
}

async function resolveInlineDataImageMime(inline: {
  data: Buffer;
  contentType?: string;
}): Promise<string | undefined> {
  const detectedMime = await getMSTeamsRuntime().media.detectMime({
    buffer: inline.data,
    headerMime: inline.contentType,
  });
  const mime = normalizeOptionalLowercaseString(detectedMime ?? inline.contentType);
  return mime?.startsWith("image/") ? mime : undefined;
}

export async function downloadMSTeamsAttachments(params: {
  attachments: MSTeamsAttachmentLike[] | undefined;
  maxBytes: number;
  tokenProvider?: MSTeamsAccessTokenProvider;
  allowHosts?: string[];
  authAllowHosts?: string[];
  deadline?: MSTeamsRequestDeadline;
  logger?: MSTeamsAttachmentDownloadLogger;
  /** Already-acquired Graph token for reference attachments from a Graph message. */
  graphReferenceToken?: string;
}): Promise<MSTeamsInboundMedia[]> {
  const list = params.attachments ?? [];
  if (list.length === 0) {
    return [];
  }
  const policy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const allowHosts = policy.allowHosts;

  const candidates: DownloadCandidate[] = list
    .filter(isAdvertisedFileAttachment)
    .map((attachment) => {
      const candidate = isDownloadableAttachment(attachment)
        ? resolveDownloadCandidate(attachment, params.graphReferenceToken)
        : null;
      return (
        candidate ?? {
          kind: "unavailable",
          mediaKind: resolveMSTeamsMediaKind({
            contentType: normalizeContentType(attachment.contentType),
            fileName: attachment.name ?? undefined,
          }),
          sourceId: attachment.id?.trim() || undefined,
        }
      );
    });
  const maxInlineBytes = params.maxBytes;
  candidates.push(
    ...extractInlineImageReferences(list).map((candidate): DownloadCandidate => {
      if (candidate.kind === "url") {
        return {
          kind: "remote",
          mediaKind: "image",
          url: candidate.url,
          fileHint: candidate.fileHint,
          contentTypeHint: candidate.contentType,
          sourceId: candidate.sourceId,
        };
      }
      return Object.assign(candidate, { mediaKind: "image" as const });
    }),
  );
  for (const sourceId of resolveUnrepresentedHtmlAttachmentIds(list)) {
    candidates.push({
      kind: "unavailable",
      mediaKind: "document",
      sourceId,
    });
  }
  if (candidates.length === 0) {
    return [];
  }

  let totalInlineBytes = 0;
  const downloadCandidate = async (
    candidate: DownloadCandidate,
  ): Promise<MSTeamsInboundMedia | undefined> => {
    if (candidate.kind === "unavailable") {
      return undefined;
    }
    if (candidate.kind === "data") {
      const match = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,(.*)$/i.exec(candidate.src);
      if (!match) {
        return undefined;
      }
      const declaredContentType = normalizeLowercaseStringOrEmpty(match[1] ?? "");
      const isBase64 = Boolean(match[2]);
      if (!isBase64) {
        return undefined;
      }
      const payload = match[3] ?? "";
      const canonicalPayload = canonicalizeInlineBase64Payload(payload);
      if (!canonicalPayload) {
        return undefined;
      }

      // Validation above guarantees whitespace-free base64 for this allocation-free size check.
      const estimatedBytes = Buffer.byteLength(canonicalPayload, "base64");
      if (
        estimatedBytes <= 0 ||
        estimatedBytes > maxInlineBytes ||
        totalInlineBytes + estimatedBytes > maxInlineBytes
      ) {
        return undefined;
      }
      const decoded = {
        data: Buffer.from(canonicalPayload, "base64"),
        contentType: declaredContentType,
        estimatedBytes,
      };
      // Accepted bytes still consume the message budget when MIME detection or saving fails.
      totalInlineBytes += decoded.estimatedBytes;
      try {
        const contentType = await resolveInlineDataImageMime(decoded);
        if (!contentType) {
          return undefined;
        }
        const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
          decoded.data,
          contentType,
          "inbound",
          params.maxBytes,
        );
        return { path: saved.path, contentType: saved.contentType, kind: "image" };
      } catch (err) {
        params.logger?.warn?.("msteams inline attachment decode failed", {
          error: coerceErrorMessage(err),
        });
      }
      return undefined;
    }
    if (!isUrlAllowed(candidate.url, allowHosts)) {
      return undefined;
    }
    try {
      return await downloadAndStoreMSTeamsRemoteMedia({
        url: candidate.url,
        filePathHint: candidate.fileHint ?? candidate.url,
        maxBytes: params.maxBytes,
        contentTypeHint: candidate.contentTypeHint,
        kind: candidate.graphReference ? undefined : candidate.mediaKind,
        // `fetchImpl` below owns Teams auth fallback and enforces the
        // attachment fetch policy through `safeFetchWithPolicy`.
        fetchImpl: async (input, init) => {
          const url = resolveRequestUrl(input);
          const providedTokenProvider = params.tokenProvider;
          const deadline = params.deadline;
          const bearerToken = candidate.graphReference ? params.graphReferenceToken : undefined;
          const fetchAttempt = (requestInit?: RequestInit) =>
            safeFetchWithPolicy({
              url,
              policy,
              resolveFn: lookup,
              requestInit,
              timeoutMs: resolveMSTeamsRequestTimeoutMs(deadline),
            });
          if (bearerToken !== undefined) {
            const headers = ensureUserAgentHeader(init?.headers);
            applyAuthorizationHeaderForUrl({
              headers,
              url,
              authAllowHosts: policy.authAllowHosts,
              bearerToken,
            });
            return fetchAttempt({ ...init, headers });
          }
          const firstAttempt = await fetchAttempt(init);
          if (firstAttempt.ok) {
            return firstAttempt;
          }
          if (!providedTokenProvider) {
            return firstAttempt;
          }
          const tokenProvider = providedTokenProvider;
          if (firstAttempt.status !== 401 && firstAttempt.status !== 403) {
            return firstAttempt;
          }
          if (!isUrlAllowed(url, policy.authAllowHosts)) {
            return firstAttempt;
          }
          let fallbackAttempt = firstAttempt;
          const scopes = scopeCandidatesForUrl(url);
          for (const scope of scopes) {
            try {
              const token = await withMSTeamsRequestDeadline({
                deadline,
                label: "MS Teams attachment token",
                work: () => tokenProvider.getAccessToken(scope),
              });
              const authHeaders = new Headers(init?.headers);
              authHeaders.set("Authorization", `Bearer ${token}`);
              const authAttempt = await fetchAttempt({
                ...init,
                headers: authHeaders,
              });
              await fallbackAttempt.body?.cancel().catch(() => undefined);
              if (authAttempt.ok || isRedirectStatus(authAttempt.status)) {
                // Redirects in guarded fetch mode must propagate to the outer guard.
                return authAttempt;
              }
              fallbackAttempt = authAttempt;
            } catch {
              // Try the next scope.
            }
          }

          return fallbackAttempt;
        },
      });
    } catch (err) {
      if (candidate.graphReference) {
        params.logger?.warn?.("msteams SharePoint reference download failed", {
          error: coerceErrorMessage(err),
          name: candidate.fileHint,
        });
        return undefined;
      }
      const msg = coerceErrorMessage(err);
      params.logger?.warn?.(
        `msteams attachment download failed host=${safeHostForLog(candidate.url)} error=${msg}`,
      );
    }
    return undefined;
  };
  const out: MSTeamsInboundMedia[] = [];
  for (const candidate of candidates) {
    const media = (await downloadCandidate(candidate)) ?? { kind: candidate.mediaKind };
    out.push(candidate.sourceId ? { ...media, sourceId: candidate.sourceId } : media);
  }
  return out;
}

function safeHostForLog(url: string): string {
  return URL.parse(url)?.host ?? "invalid-url";
}
