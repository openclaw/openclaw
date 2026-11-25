import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import {
  readProviderJsonResponse,
  readProviderTextResponse,
} from "openclaw/plugin-sdk/provider-http";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsAsciiControlCharacter as containsControlCharacter } from "openclaw/plugin-sdk/string-normalization-runtime";
import { fetchWithSsrFGuard, type OpenClawConfig, type PluginRuntime } from "../runtime-api.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";
import { normalizeNextcloudTalkAllowEntry, resolveNextcloudTalkAllowlistMatch } from "./policy.js";
import type { NextcloudTalkAccountConfig, NextcloudTalkInboundAttachment } from "./types.js";
import { parseWebDavFileId } from "./webdav.js";

const DEFAULT_NEXTCLOUD_TALK_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const NEXTCLOUD_TALK_MEDIA_RESPONSE_HEADER_TIMEOUT_MS = 120_000;
const NEXTCLOUD_TALK_MEDIA_READ_IDLE_TIMEOUT_MS = 30_000;
const NEXTCLOUD_TALK_WEBDAV_FILE_ID_REQUEST =
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>';

export type NextcloudTalkMediaOutcomeReason =
  | "media_sender_not_allowlisted"
  | "media_hidden_download"
  | "media_missing_metadata"
  | "media_invalid_link"
  | "media_origin_mismatch"
  | "media_auth_unavailable"
  | "media_message_mismatch"
  | "media_declared_oversize"
  | "media_download_oversize"
  | "media_unavailable"
  | "media_unsupported"
  | "media_fetch_failed"
  | "media_stage_failed"
  | "media_cleanup_failed";

export type NextcloudTalkAttachmentReferenceResult =
  | { ok: true; origin: string; hostname: string; fileName: string }
  | { ok: false; reason: "media_invalid_link" | "media_origin_mismatch" };

type NextcloudTalkAuthenticatedMediaSourceResult =
  | {
      ok: true;
      url: string;
      origin: string;
      hostname: string;
      fileName: string;
      authorization: string;
      contentTypeOverride?: string;
      sourceModality?: "voice";
    }
  | {
      ok: false;
      reason:
        | "media_auth_unavailable"
        | "media_fetch_failed"
        | "media_message_mismatch"
        | "media_unavailable";
      status?: number;
    };

function boundedLogField(value: string): string {
  return value.replace(/[^a-z0-9._:/-]/giu, "_").slice(0, 128) || "unknown";
}

export function isNextcloudTalkMediaSenderAllowed(params: {
  mediaAllowFrom: string[] | undefined;
  senderId: string;
}): boolean {
  return resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.mediaAllowFrom,
    senderId: params.senderId,
  }).allowed;
}

export function resolveNextcloudTalkMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId: string;
  mediaMaxMb: number | undefined;
}): number {
  return (
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: () => params.mediaMaxMb,
    }) ?? DEFAULT_NEXTCLOUD_TALK_MEDIA_MAX_BYTES
  );
}

export function resolveNextcloudTalkAttachmentReference(params: {
  baseUrl: string;
  shareUrl: string;
  fileName: string;
}): NextcloudTalkAttachmentReferenceResult {
  let base: URL;
  let share: URL;
  try {
    base = new URL(params.baseUrl);
    share = new URL(params.shareUrl);
  } catch {
    return { ok: false, reason: "media_invalid_link" };
  }
  const fileName = sanitizeUntrustedFileName(params.fileName, "");
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    (share.protocol !== "http:" && share.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    share.username ||
    share.password ||
    share.search ||
    share.hash ||
    !fileName
  ) {
    return { ok: false, reason: "media_invalid_link" };
  }
  if (share.origin !== base.origin) {
    return { ok: false, reason: "media_origin_mismatch" };
  }

  const basePath = base.pathname.replace(/\/+$/u, "");
  const prefix = ["/s/", "/index.php/s/", "/index.php/f/", "/f/"]
    .map((route) => `${basePath}${route}`)
    .find((route) => share.pathname.startsWith(route));
  const suffix = prefix ? share.pathname.slice(prefix.length) : "";
  if (!suffix || suffix.includes("/")) {
    return { ok: false, reason: "media_invalid_link" };
  }

  return {
    ok: true,
    origin: base.origin,
    hostname: base.hostname,
    fileName,
  };
}

function buildBasicAuthorization(apiUser: string, apiPassword: string): string {
  return `Basic ${Buffer.from(`${apiUser}:${apiPassword}`, "utf8").toString("base64")}`;
}

function buildSameOriginUrl(base: URL, pathname: string): URL {
  const url = new URL(base.origin);
  url.pathname = `${base.pathname.replace(/\/+$/u, "")}${pathname}`;
  return url;
}

function resolveCanonicalUserId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.ocs) || !isRecord(payload.ocs.data)) {
    return undefined;
  }
  return normalizeOptionalString(payload.ocs.data.id);
}

function parseHistorySize(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/u.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function resolveNextcloudTalkAuthenticatedMediaSource(params: {
  baseUrl: string;
  roomToken: string;
  messageId: string;
  senderId: string;
  attachment: NextcloudTalkInboundAttachment;
  accountConfig: NextcloudTalkAccountConfig;
  reference: Extract<NextcloudTalkAttachmentReferenceResult, { ok: true }>;
  signal?: AbortSignal;
}): Promise<NextcloudTalkAuthenticatedMediaSourceResult> {
  params.signal?.throwIfAborted();
  const credentials = resolveNextcloudTalkApiCredentials({
    apiUser: params.accountConfig.apiUser,
    apiPassword: params.accountConfig.apiPassword,
    apiPasswordFile: params.accountConfig.apiPasswordFile,
  });
  if (!credentials) {
    return { ok: false, reason: "media_auth_unavailable" };
  }
  const base = new URL(params.baseUrl);
  const authorization = buildBasicAuthorization(credentials.apiUser, credentials.apiPassword);
  async function fetchLookup<T>(
    url: string,
    auditContext: string,
    init: RequestInit,
    readResponse: (response: Response) => Promise<T>,
    expectedStatus?: number,
  ): Promise<T | { ok: false; status?: number }> {
    const { origin, hostname } = params.reference;
    const { accountConfig, signal } = params;
    try {
      signal?.throwIfAborted();
      const privateNetworkPolicy = ssrfPolicyFromPrivateNetworkOptIn(accountConfig);
      const { response, release } = await fetchWithSsrFGuard({
        url,
        init,
        maxRedirects: 0,
        requireHttps: new URL(origin).protocol === "https:",
        timeoutMs: NEXTCLOUD_TALK_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        policy: {
          ...privateNetworkPolicy,
          hostnameAllowlist: [hostname],
        },
        auditContext,
      });
      try {
        if (expectedStatus === undefined ? !response.ok : response.status !== expectedStatus) {
          return { ok: false, status: response.status };
        }
        return await readResponse(response);
      } finally {
        await releaseNextcloudTalkGuardedResponse({ response, release });
      }
    } catch {
      signal?.throwIfAborted();
      return { ok: false };
    }
  }
  async function fetchJson(url: string, auditContext: string) {
    return fetchLookup(
      url,
      auditContext,
      {
        method: "GET",
        headers: {
          Authorization: authorization,
          "OCS-APIRequest": "true",
          Accept: "application/json",
        },
      },
      async (response) => {
        const payload = await readProviderJsonResponse<unknown>(
          response,
          "Nextcloud Talk media lookup",
          {
            maxBytes: 64 * 1024,
            chunkTimeoutMs: NEXTCLOUD_TALK_MEDIA_READ_IDLE_TIMEOUT_MS,
          },
        );
        params.signal?.throwIfAborted();
        return { ok: true as const, payload };
      },
    );
  }
  const userUrl = buildSameOriginUrl(base, "/ocs/v1.php/cloud/user");
  userUrl.searchParams.set("format", "json");
  const user = await fetchJson(userUrl.toString(), "nextcloud-talk.inbound-media-user");
  if (!user.ok) {
    return {
      ok: false,
      reason:
        user.status === 401 || user.status === 403
          ? "media_auth_unavailable"
          : "media_fetch_failed",
      ...(user.status === undefined ? {} : { status: user.status }),
    };
  }
  const canonicalUserId = resolveCanonicalUserId(user.payload);
  if (!canonicalUserId) {
    return { ok: false, reason: "media_auth_unavailable" };
  }
  params.signal?.throwIfAborted();

  const historyUrl = buildSameOriginUrl(
    base,
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(params.roomToken)}`,
  );
  historyUrl.searchParams.set("lookIntoFuture", "0");
  historyUrl.searchParams.set("limit", "1");
  historyUrl.searchParams.set("lastKnownMessageId", params.messageId);
  historyUrl.searchParams.set("includeLastKnown", "1");
  historyUrl.searchParams.set("setReadMarker", "0");
  historyUrl.searchParams.set("noStatusUpdate", "1");
  historyUrl.searchParams.set("markNotificationsAsRead", "0");
  const history = await fetchJson(historyUrl.toString(), "nextcloud-talk.inbound-media-message");
  if (!history.ok) {
    return {
      ok: false,
      reason:
        history.status === 401 || history.status === 403
          ? "media_auth_unavailable"
          : history.status === 404
            ? "media_unavailable"
            : "media_fetch_failed",
      ...(history.status === undefined ? {} : { status: history.status }),
    };
  }
  const exactHistoryMedia = (() => {
    const payload = history.payload;
    if (!isRecord(payload) || !isRecord(payload.ocs)) {
      return undefined;
    }
    const data = payload.ocs.data;
    if (!Array.isArray(data)) {
      return undefined;
    }
    const message = data.find(
      (candidate) => isRecord(candidate) && String(candidate.id) === params.messageId,
    );
    if (!isRecord(message) || message.token !== params.roomToken) {
      return undefined;
    }
    const actorType = typeof message.actorType === "string" ? message.actorType : "";
    const actorId = typeof message.actorId === "string" ? message.actorId : "";
    if (
      normalizeNextcloudTalkAllowEntry(`${actorType}/${actorId}`) !==
      normalizeNextcloudTalkAllowEntry(params.senderId)
    ) {
      return undefined;
    }
    if (!isRecord(message.messageParameters) || !isRecord(message.messageParameters.file)) {
      return undefined;
    }
    const file = message.messageParameters.file;
    const fileId =
      typeof file.id === "string"
        ? file.id.trim()
        : typeof file.id === "number" && Number.isSafeInteger(file.id)
          ? String(file.id)
          : "";
    const name = typeof file.name === "string" ? file.name.trim() : "";
    const mimeType = typeof file.mimetype === "string" ? file.mimetype.trim() : "";
    const path = typeof file.path === "string" ? file.path.trim() : "";
    const hideDownload = file["hide-download"];
    if (
      !/^\d+$/u.test(fileId) ||
      (params.attachment.fileId && fileId !== params.attachment.fileId) ||
      !name ||
      mimeType !== params.attachment.mimeType ||
      parseHistorySize(file.size) !== params.attachment.declaredSizeBytes ||
      (hideDownload !== undefined && hideDownload !== "yes" && hideDownload !== "no") ||
      (hideDownload === "yes") !== params.attachment.hideDownload ||
      !path
    ) {
      return undefined;
    }
    const segments = path.split("/");
    if (
      segments.some(
        (segment) =>
          !segment || segment === "." || segment === ".." || containsControlCharacter(segment),
      ) ||
      segments.at(-1) !== name
    ) {
      return undefined;
    }
    const encodedFilePath = segments.map((segment) => encodeURIComponent(segment)).join("/");
    const messageType = typeof message.messageType === "string" ? message.messageType : "";
    const contentTypeOverride =
      messageType === "voice-message" && /^video\//iu.test(mimeType)
        ? mimeType.replace(/^video\//iu, "audio/")
        : undefined;
    return {
      fileId,
      encodedFilePath,
      ...(contentTypeOverride ? { contentTypeOverride } : {}),
      ...(messageType === "voice-message" ? { sourceModality: "voice" as const } : {}),
    };
  })();
  if (!exactHistoryMedia) {
    return { ok: false, reason: "media_message_mismatch" };
  }
  const webDavUrl = buildSameOriginUrl(
    base,
    `/remote.php/dav/files/${encodeURIComponent(canonicalUserId)}/${exactHistoryMedia.encodedFilePath}`,
  );
  const webDavFile = await fetchLookup(
    webDavUrl.toString(),
    "nextcloud-talk.inbound-media-file-id",
    {
      method: "PROPFIND",
      headers: {
        Authorization: authorization,
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
        Accept: "application/xml",
      },
      body: NEXTCLOUD_TALK_WEBDAV_FILE_ID_REQUEST,
    },
    async (response): Promise<{ ok: true; fileId: string } | { ok: false; status?: number }> => {
      const xml = await readProviderTextResponse(response, "Nextcloud Talk file identity", {
        maxBytes: 64 * 1024,
        chunkTimeoutMs: NEXTCLOUD_TALK_MEDIA_READ_IDLE_TIMEOUT_MS,
      });
      params.signal?.throwIfAborted();
      const fileId = parseWebDavFileId(xml);
      return fileId ? { ok: true, fileId } : { ok: false };
    },
    207,
  );
  if (!webDavFile.ok) {
    return {
      ok: false,
      reason: webDavFile.status === 404 ? "media_unavailable" : "media_fetch_failed",
      ...(webDavFile.status === undefined ? {} : { status: webDavFile.status }),
    };
  }
  if (webDavFile.fileId !== exactHistoryMedia.fileId) {
    return { ok: false, reason: "media_message_mismatch" };
  }
  return {
    ok: true,
    url: webDavUrl.toString(),
    origin: params.reference.origin,
    hostname: params.reference.hostname,
    fileName: params.reference.fileName,
    authorization,
    ...(exactHistoryMedia.contentTypeOverride
      ? { contentTypeOverride: exactHistoryMedia.contentTypeOverride }
      : {}),
    ...(exactHistoryMedia.sourceModality
      ? { sourceModality: exactHistoryMedia.sourceModality }
      : {}),
  };
}

type NextcloudTalkSaveRemoteMedia = PluginRuntime["channel"]["media"]["saveRemoteMedia"];

type NextcloudTalkMediaFailure = {
  reason: Extract<
    NextcloudTalkMediaOutcomeReason,
    "media_download_oversize" | "media_unavailable" | "media_fetch_failed" | "media_stage_failed"
  >;
  status?: number;
};

export function classifyNextcloudTalkMediaFailure(error: unknown): NextcloudTalkMediaFailure {
  if (!(error instanceof MediaFetchError)) {
    return { reason: "media_stage_failed" };
  }
  if (error.code === "max_bytes") {
    return { reason: "media_download_oversize" };
  }
  if (error.code === "http_error") {
    return {
      reason: "media_unavailable",
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { reason: "media_fetch_failed" };
}

export async function saveNextcloudTalkInboundMedia(params: {
  saveRemoteMedia: NextcloudTalkSaveRemoteMedia;
  url: string;
  origin: string;
  hostname: string;
  accountConfig: NextcloudTalkAccountConfig;
  maxBytes: number;
  fileName: string;
  mimeType: string;
  authorization: string;
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<NextcloudTalkSaveRemoteMedia>>> {
  params.signal?.throwIfAborted();
  const originProtocol = new URL(params.origin).protocol;
  const privateNetworkPolicy = ssrfPolicyFromPrivateNetworkOptIn(params.accountConfig);
  return await params.saveRemoteMedia({
    url: params.url,
    maxBytes: params.maxBytes,
    maxRedirects: 0,
    requestInit: {
      headers: { Authorization: params.authorization },
      ...(params.signal ? { signal: params.signal } : {}),
    },
    requireHttps: originProtocol === "https:",
    responseHeaderTimeoutMs: NEXTCLOUD_TALK_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
    readIdleTimeoutMs: NEXTCLOUD_TALK_MEDIA_READ_IDLE_TIMEOUT_MS,
    filePathHint: params.fileName,
    fallbackContentType: params.mimeType,
    originalFilename: params.fileName,
    ssrfPolicy: {
      ...privateNetworkPolicy,
      hostnameAllowlist: [params.hostname],
    },
  });
}

export function logNextcloudTalkMediaNonOutcome(params: {
  log?: (message: string) => void;
  reason: NextcloudTalkMediaOutcomeReason;
  accountId: string;
  messageId: string;
  senderId: string;
  status?: number;
  sizeBytes?: number;
  maxBytes?: number;
}): void {
  const fields = [
    `reason=${params.reason}`,
    `account=${boundedLogField(params.accountId)}`,
    `message=${boundedLogField(params.messageId)}`,
    `sender=${boundedLogField(normalizeNextcloudTalkAllowEntry(params.senderId))}`,
    ...(params.status === undefined ? [] : [`status=${params.status}`]),
    ...(params.sizeBytes === undefined ? [] : [`sizeBytes=${params.sizeBytes}`]),
    ...(params.maxBytes === undefined ? [] : [`maxBytes=${params.maxBytes}`]),
  ];
  params.log?.(`nextcloud-talk: inbound media non-outcome ${fields.join(" ")}`);
}
