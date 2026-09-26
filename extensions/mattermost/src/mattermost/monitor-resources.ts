import {
  buildChannelInboundMediaPayload,
  formatInboundMediaUnavailableText,
  formatMediaPlaceholderText,
  toInboundMediaFactsWithMetadata,
  type ChannelInboundMediaInput,
  type ChannelInboundMediaPayload,
  type InboundMediaFacts,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { MediaKind, SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  buildMattermostApiUrl,
  fetchMattermostChannel,
  fetchMattermostUser,
  MattermostPostSchema,
  sendMattermostTyping,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";
import { buildButtonProps, type MattermostInteractionResponse } from "./interactions.js";

type MattermostMediaInfo = Pick<ChannelInboundMediaInput, "contentType" | "fileName" | "path"> & {
  kind: MediaKind;
};

export async function buildMattermostInboundMediaPayload(
  media: readonly MattermostMediaInfo[],
): Promise<ChannelInboundMediaPayload & { media: InboundMediaFacts[] }> {
  const facts = await toInboundMediaFactsWithMetadata(media);
  return { ...buildChannelInboundMediaPayload(facts), media: facts };
}

export function formatMattermostPendingMediaText(params: {
  body: string;
  media: readonly MediaPlaceholderTextFact[];
}): string {
  return [params.body, formatMediaPlaceholderText(params.media)].filter(Boolean).join("\n").trim();
}

function sanitizeOptionalAttachmentName(fileName: string): string {
  const sanitized = sanitizeUntrustedFileName(fileName, "_");
  // Distinguish an unusable name from a real filename matching the fallback.
  if (sanitized === "_" && sanitizeUntrustedFileName(fileName, "-") === "-") {
    return "";
  }
  return sanitized;
}

export function formatMattermostInboundMediaText(params: {
  body: string;
  nativeMedia: readonly MediaPlaceholderTextFact[];
  materializedMedia: readonly ChannelInboundMediaInput[];
}): string {
  const materializedCount = params.materializedMedia.filter(
    (media) => Boolean(media.path) || Boolean(media.url),
  ).length;
  const unavailableCount = Math.max(0, params.nativeMedia.length - materializedCount);
  if (unavailableCount === 0) {
    return params.body;
  }
  const unavailableFileNames = params.materializedMedia
    .filter((media) => !media.path && !media.url && media.fileName)
    .map((media) => sanitizeOptionalAttachmentName(media.fileName ?? ""))
    .filter(Boolean)
    .join(", ");
  const fileNameNotice = unavailableFileNames
    ? ` ${JSON.stringify(truncateUtf16Safe(unavailableFileNames, 512))}`
    : "";
  return formatInboundMediaUnavailableText({
    body: params.body,
    notice: `[mattermost ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]${fileNameNotice}`,
  });
}

const CHANNEL_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;
// Reaction side paths read a post's thread root; posts are immutable except for edits.
const POST_CACHE_TTL_MS = 5 * 60_000;
const MONITOR_RESOURCE_CACHE_MAX_ENTRIES = 1000;
// Match Telegram/Tlon inbound media: header wait is independent of body idle.
const MATTERMOST_MEDIA_RESPONSE_HEADER_TIMEOUT_MS = 120_000;
const MATTERMOST_MEDIA_READ_IDLE_TIMEOUT_MS = 30_000;

type SaveRemoteMedia = (params: {
  url: string;
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes: number;
  ssrfPolicy?: { allowedHostnames?: string[] };
  responseHeaderTimeoutMs?: number;
  readIdleTimeoutMs?: number;
}) => Promise<Pick<SavedRemoteMedia, "contentType" | "fileName" | "path">>;

export function createMattermostMonitorResources(params: {
  accountId: string;
  callbackUrl: string;
  client: MattermostClient;
  logger: { debug?: (...args: unknown[]) => void };
  mediaMaxBytes: number;
  saveRemoteMedia: SaveRemoteMedia;
  mediaKindFromMime: (contentType?: string) => MediaKind | null | undefined;
}) {
  const {
    accountId,
    callbackUrl,
    client,
    logger,
    mediaMaxBytes,
    saveRemoteMedia,
    mediaKindFromMime,
  } = params;
  function createCachedLookup<T>(
    label: string,
    ttlMs: number,
    fetchValue: (id: string) => Promise<T>,
  ): (id: string) => Promise<T | null> {
    // Cache only resolved resources: failures must not hide a channel or sender for a TTL.
    const cache = new Map<string, { value: T; expiresAt: number }>();
    return async (id) => {
      const rawNow = Date.now();
      const now = asDateTimestampMs(rawNow);
      const cached = cache.get(id);
      if (cached && now !== undefined && cached.expiresAt > now) {
        if (cached.value !== undefined) {
          return cached.value;
        }
      } else {
        cache.delete(id);
      }
      try {
        const value = await fetchValue(id);
        const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
        if (expiresAt !== undefined) {
          // Concurrent misses can resolve out of order; retain the most recently resolved values.
          cache.delete(id);
          cache.set(id, { value, expiresAt });
          pruneMapToMaxSize(cache, MONITOR_RESOURCE_CACHE_MAX_ENTRIES);
        }
        return value;
      } catch (err) {
        logger.debug?.(`mattermost: ${label} lookup failed: ${String(err)}`);
        return null;
      }
    };
  }

  const resolveMattermostMedia = async (
    fileIds?: string[] | null,
  ): Promise<MattermostMediaInfo[]> => {
    const ids = normalizeStringEntries(fileIds ?? []);
    if (ids.length === 0) {
      return [];
    }
    const out: MattermostMediaInfo[] = [];
    for (const fileId of ids) {
      let downloadUrl: string;
      try {
        downloadUrl = buildMattermostApiUrl(client.baseUrl, `/files/${fileId}`);
      } catch (err) {
        logger.debug?.(`mattermost: failed to resolve file ${fileId}: ${String(err)}`);
        // Keep the fact list aligned one-per-native-file so a rejected ID cannot
        // shift later attachments' payload positions; no download is attempted.
        out.push({ kind: "unknown" });
        continue;
      }
      try {
        const saved = await saveRemoteMedia({
          url: downloadUrl,
          requestInit: {
            headers: {
              Authorization: `Bearer ${client.token}`,
            },
          },
          filePathHint: fileId,
          maxBytes: mediaMaxBytes,
          ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] },
          // Without these, a Mattermost host that never returns headers can stall
          // inbound preprocessing indefinitely (idle timeout never starts).
          responseHeaderTimeoutMs: MATTERMOST_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
          readIdleTimeoutMs: MATTERMOST_MEDIA_READ_IDLE_TIMEOUT_MS,
        });
        const contentType = saved.contentType ?? undefined;
        out.push({
          path: saved.path,
          contentType,
          ...(saved.fileName ? { fileName: saved.fileName } : {}),
          kind: mediaKindFromMime(contentType) ?? "unknown",
        });
      } catch (err) {
        logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(err)}`);
        let info: { mime_type?: string | null; name?: string | null } | undefined;
        try {
          info = await client.request(`/files/${fileId}/info`);
        } catch (infoErr) {
          logger.debug?.(
            `mattermost: failed to resolve metadata for file ${fileId}: ${String(infoErr)}`,
          );
        }
        const contentType = info?.mime_type?.trim() || undefined;
        const fileName = info?.name?.trim();
        out.push({
          contentType,
          ...(fileName ? { fileName } : {}),
          kind: mediaKindFromMime(contentType) ?? "unknown",
        });
      }
    }
    return out;
  };

  const sendTypingIndicator = async (channelId: string, parentId?: string) => {
    await sendMattermostTyping(client, { channelId, parentId });
  };

  const resolveChannelInfo = createCachedLookup("channel", CHANNEL_CACHE_TTL_MS, (channelId) =>
    fetchMattermostChannel(client, channelId),
  );
  const resolveUserInfo = createCachedLookup("user", USER_CACHE_TTL_MS, (userId) =>
    fetchMattermostUser(client, userId),
  );
  const resolvePostInfo = createCachedLookup("post", POST_CACHE_TTL_MS, async (postId) => {
    // A different id cannot be trusted for thread placement.
    const info = MattermostPostSchema.parse(
      await client.request<unknown>(`/posts/${encodeURIComponent(postId)}`),
    );
    if (info.id !== postId) {
      throw new Error("Mattermost post lookup returned a different post id");
    }
    return info;
  });

  const updateModelPickerPost = async (paramsLocal: {
    channelId: string;
    postId: string;
    message: string;
    buttons?: Array<unknown>;
  }): Promise<MattermostInteractionResponse> => {
    const props = buildButtonProps({
      callbackUrl,
      accountId,
      channelId: paramsLocal.channelId,
      buttons: paramsLocal.buttons ?? [],
    }) ?? { attachments: [] };
    await updateMattermostPost(client, paramsLocal.postId, {
      message: paramsLocal.message,
      props,
    });
    return {};
  };

  return {
    resolveMattermostMedia,
    sendTypingIndicator,
    resolveChannelInfo,
    resolveUserInfo,
    resolvePostInfo,
    updateModelPickerPost,
  };
}
