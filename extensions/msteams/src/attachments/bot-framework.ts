import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseMediaContentLength } from "openclaw/plugin-sdk/media-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { isHttpsUrlAllowedByHostnameSuffixAllowlist as isUrlAllowed } from "openclaw/plugin-sdk/ssrf-policy";
import { normalizeUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveMSTeamsRequestTimeoutMs,
  type MSTeamsRequestDeadline,
  withMSTeamsRequestDeadline,
} from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { ensureUserAgentHeader } from "../user-agent.js";
import {
  applyAuthorizationHeaderForUrl,
  type MSTeamsAttachmentDownloadLogger,
  type MSTeamsAttachmentFetchPolicy,
  type MSTeamsAttachmentResolveFn,
  resolveAttachmentFetchPolicy,
  resolveMSTeamsMediaKind,
  safeFetchWithPolicy,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsGraphMediaResult,
  MSTeamsInboundMedia,
} from "./types.js";

const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com";

/**
 * Detect Bot Framework personal chat ("a:") and MSA orgid ("8:orgid:") conversation
 * IDs. These identifiers are not recognized by Graph's `/chats/{id}` endpoint, so we
 * must fetch media via the Bot Framework v3 attachments endpoint instead.
 *
 * Graph-compatible IDs start with `19:` and are left untouched by this detector.
 */
export function isBotFrameworkPersonalChatId(conversationId: string | null | undefined): boolean {
  if (typeof conversationId !== "string") {
    return false;
  }
  const trimmed = conversationId.trim();
  return trimmed.startsWith("a:") || trimmed.startsWith("8:orgid:");
}

type BotFrameworkView = {
  viewId?: string | null;
  size?: number | null;
};

type BotFrameworkAttachmentInfo = {
  name?: string | null;
  type?: string | null;
  views?: BotFrameworkView[] | null;
};

type BotFrameworkAttachmentRequest = {
  url: string;
  accessToken: string;
  policy: MSTeamsAttachmentFetchPolicy;
  fetchFn?: typeof fetch;
  fetchFnSupportsDispatcher?: boolean;
  resolveFn?: MSTeamsAttachmentResolveFn;
  logger?: MSTeamsAttachmentDownloadLogger;
  deadline?: MSTeamsRequestDeadline;
};

async function fetchBotFrameworkAttachment(
  params: BotFrameworkAttachmentRequest,
  kind: "attachmentInfo" | "attachmentView",
): Promise<Response | undefined> {
  let response: Response;
  try {
    const headers = ensureUserAgentHeader();
    applyAuthorizationHeaderForUrl({
      headers,
      url: params.url,
      authAllowHosts: params.policy.authAllowHosts,
      bearerToken: params.accessToken,
    });
    response = await safeFetchWithPolicy({
      url: params.url,
      policy: params.policy,
      fetchFn: params.fetchFn,
      fetchFnSupportsDispatcher: params.fetchFnSupportsDispatcher,
      resolveFn: params.resolveFn,
      requestInit: { headers },
      timeoutMs: resolveMSTeamsRequestTimeoutMs(params.deadline),
    });
  } catch (err) {
    params.logger?.warn?.(`msteams botFramework ${kind} fetch failed`, {
      error: coerceErrorMessage(err),
    });
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    params.logger?.warn?.(`msteams botFramework ${kind} non-ok`, {
      status: response.status,
    });
    return undefined;
  }
  return response;
}

async function fetchBotFrameworkAttachmentInfo(
  params: BotFrameworkAttachmentRequest,
): Promise<BotFrameworkAttachmentInfo | undefined> {
  const response = await fetchBotFrameworkAttachment(params, "attachmentInfo");
  if (!response) {
    return undefined;
  }
  try {
    return await readProviderJsonResponse<BotFrameworkAttachmentInfo>(
      response,
      "msteams botFramework attachmentInfo",
    );
  } catch (err) {
    params.logger?.warn?.("msteams botFramework attachmentInfo parse failed", {
      error: coerceErrorMessage(err),
    });
    return undefined;
  }
}

async function saveBotFrameworkAttachmentView(
  params: BotFrameworkAttachmentRequest & {
    maxBytes: number;
    fileNameHint?: string;
    contentTypeHint?: string;
    preserveFilenames?: boolean;
  },
): Promise<{ path: string; contentType?: string } | undefined> {
  const response = await fetchBotFrameworkAttachment(params, "attachmentView");
  if (!response) {
    return undefined;
  }
  let contentLength: number | null;
  try {
    contentLength = parseMediaContentLength(response.headers.get("content-length"));
  } catch (err) {
    await response.body?.cancel().catch(() => undefined);
    params.logger?.warn?.("msteams botFramework attachmentView invalid content-length", {
      error: coerceErrorMessage(err),
    });
    return undefined;
  }
  if (contentLength !== null && contentLength > params.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  try {
    return await getMSTeamsRuntime().channel.media.saveResponseMedia(response, {
      sourceUrl: params.url,
      filePathHint: params.fileNameHint,
      maxBytes: params.maxBytes,
      fallbackContentType: params.contentTypeHint,
      subdir: "inbound",
      originalFilename: params.preserveFilenames ? params.fileNameHint : undefined,
    });
  } catch (err) {
    params.logger?.warn?.("msteams botFramework attachmentView save failed", {
      error: coerceErrorMessage(err),
    });
    return undefined;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/**
 * Download media for a single attachment via the Bot Framework v3 attachments
 * endpoint. Used for personal DM conversations where the Graph `/chats/{id}`
 * path is not usable because the Bot Framework conversation ID (`a:...`) is
 * not a valid Graph chat identifier.
 */
type BotFrameworkDownloadOptions = {
  serviceUrl: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  fetchFnSupportsDispatcher?: boolean;
  resolveFn?: MSTeamsAttachmentResolveFn;
  deadline?: MSTeamsRequestDeadline;
  fileNameHint?: string | null;
  contentTypeHint?: string | null;
  preserveFilenames?: boolean;
  logger?: MSTeamsAttachmentDownloadLogger;
};

async function downloadMSTeamsBotFrameworkAttachment(
  params: BotFrameworkDownloadOptions & { attachmentId: string },
): Promise<MSTeamsInboundMedia | undefined> {
  if (!params.serviceUrl || !params.attachmentId || !params.tokenProvider) {
    return undefined;
  }
  const tokenProvider = params.tokenProvider;
  const policy: MSTeamsAttachmentFetchPolicy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const baseUrl = `${params.serviceUrl.replace(/\/+$/, "")}/v3/attachments/${encodeURIComponent(params.attachmentId)}`;
  if (!isUrlAllowed(baseUrl, policy.allowHosts)) {
    return undefined;
  }

  let accessToken: string;
  try {
    accessToken = await withMSTeamsRequestDeadline({
      deadline: params.deadline,
      label: "MS Teams Bot Framework token",
      work: () => tokenProvider.getAccessToken(BOT_FRAMEWORK_SCOPE),
    });
  } catch (err) {
    params.logger?.warn?.("msteams botFramework token acquisition failed", {
      error: coerceErrorMessage(err),
    });
    return undefined;
  }
  if (!accessToken) {
    return undefined;
  }

  const request: BotFrameworkAttachmentRequest = {
    url: baseUrl,
    accessToken,
    policy,
    fetchFn: params.fetchFn,
    fetchFnSupportsDispatcher: params.fetchFnSupportsDispatcher,
    resolveFn: params.resolveFn,
    logger: params.logger,
    deadline: params.deadline,
  };
  const info = await fetchBotFrameworkAttachmentInfo(request);
  if (!info) {
    return undefined;
  }

  const views = Array.isArray(info.views) ? info.views : [];
  // Prefer the "original" view when present, otherwise fall back to the first
  // view the Bot Framework service returned.
  const original = views.find((view) => view?.viewId === "original");
  const candidateView = original ?? views.find((view) => typeof view?.viewId === "string");
  const viewId =
    typeof candidateView?.viewId === "string" && candidateView.viewId
      ? candidateView.viewId
      : undefined;
  if (!viewId) {
    return undefined;
  }
  if (
    typeof candidateView?.size === "number" &&
    candidateView.size > 0 &&
    candidateView.size > params.maxBytes
  ) {
    return undefined;
  }

  const fileNameHint =
    (typeof params.fileNameHint === "string" && params.fileNameHint) ||
    (typeof info.name === "string" && info.name) ||
    undefined;
  const contentTypeHint =
    (typeof params.contentTypeHint === "string" && params.contentTypeHint) ||
    (typeof info.type === "string" && info.type) ||
    undefined;

  const saved = await saveBotFrameworkAttachmentView({
    ...request,
    url: `${baseUrl}/views/${encodeURIComponent(viewId)}`,
    maxBytes: params.maxBytes,
    fileNameHint,
    contentTypeHint,
    preserveFilenames: params.preserveFilenames,
  });
  if (!saved) {
    return undefined;
  }

  return {
    path: saved.path,
    contentType: saved.contentType,
    kind: resolveMSTeamsMediaKind({ contentType: saved.contentType, fileName: fileNameHint }),
  };
}

/**
 * Download media for every attachment referenced by a Bot Framework personal
 * chat activity. Returns all successfully fetched media along with diagnostics
 * compatible with `downloadMSTeamsGraphMedia`'s result shape so callers can
 * reuse the existing logging path.
 */
export async function downloadMSTeamsBotFrameworkAttachments(
  params: BotFrameworkDownloadOptions & { attachmentIds: string[] },
): Promise<MSTeamsGraphMediaResult> {
  const unique = normalizeUniqueTrimmedStringList(params.attachmentIds);
  if (unique.length === 0 || !params.serviceUrl || !params.tokenProvider) {
    return { media: [], attachmentCount: unique.length };
  }

  const media: MSTeamsInboundMedia[] = [];
  for (const attachmentId of unique) {
    try {
      const item = await downloadMSTeamsBotFrameworkAttachment({
        ...params,
        attachmentId,
      });
      if (item) {
        media.push({ ...item, sourceId: attachmentId });
      } else {
        media.push({ kind: "document", sourceId: attachmentId });
      }
    } catch (err) {
      media.push({ kind: "document", sourceId: attachmentId });
      params.logger?.warn?.("msteams botFramework attachment download failed", {
        error: coerceErrorMessage(err),
        attachmentId,
      });
    }
  }

  return {
    media,
    attachmentCount: unique.length,
  };
}
