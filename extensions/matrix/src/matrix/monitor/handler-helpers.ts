import { getSessionEntryAsync } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CoreConfig } from "../../types.js";
import { formatMatrixGalleryText, formatMatrixMessageText } from "../media-text.js";
import { formatPollAsText, isPollStartType, parsePollStart } from "../poll-types.js";
import type { EncryptedFile } from "../sdk.js";
import { RelationType } from "../send/types.js";
import { resolveMatrixStoredSessionMeta } from "../session-store-metadata.js";
import { isMatrixAudioContent } from "./preflight-audio.js";
import type { RoomMessageEventContent, MatrixRawEvent } from "./types.js";

const MATRIX_TOOL_PROGRESS_MAX_CHARS = 300;
const MAX_TRACKED_SHARED_DM_CONTEXT_NOTICES = 512;
type MatrixAllowBotsMode = "off" | "mentions" | "all";

export function resolveMatrixMentionPrecheckText(params: {
  eventType: string;
  content: RoomMessageEventContent;
  locationText?: string | null;
}): string {
  if (params.locationText?.trim()) {
    return params.locationText.trim();
  }
  if (typeof params.content.body === "string" && params.content.body.trim()) {
    return params.content.body.trim();
  }
  if (isPollStartType(params.eventType)) {
    const parsed = parsePollStart(params.content as never);
    if (parsed) {
      return formatPollAsText(parsed);
    }
  }
  return "";
}

export function hasBundledMatrixReplacementRelation(event: MatrixRawEvent) {
  const relations = event.unsigned?.["m.relations"];
  if (!relations || typeof relations !== "object") {
    return false;
  }
  return relations[RelationType.Replace] !== undefined;
}

export function markTrackedRoomIfFirst(set: Set<string>, roomId: string): boolean {
  if (set.has(roomId)) {
    return false;
  }
  set.add(roomId);
  if (set.size > MAX_TRACKED_SHARED_DM_CONTEXT_NOTICES) {
    const oldest = set.keys().next().value;
    if (typeof oldest === "string") {
      set.delete(oldest);
    }
  }
  return true;
}

export async function resolveMatrixSharedDmContextNotice(params: {
  storePath: string;
  sessionKey: string;
  roomId: string;
  accountId: string;
  dmSessionScope?: "per-user" | "per-room";
  sentRooms: Set<string>;
  logVerboseMessage: (message: string) => void;
}): Promise<string | null> {
  if ((params.dmSessionScope ?? "per-user") === "per-room") {
    return null;
  }
  if (params.sentRooms.has(params.roomId)) {
    return null;
  }

  try {
    const currentSession = resolveMatrixStoredSessionMeta(
      await getSessionEntryAsync({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
      }),
    );
    if (!currentSession) {
      return null;
    }
    if (currentSession.channel && currentSession.channel !== "matrix") {
      return null;
    }
    if (currentSession.accountId && currentSession.accountId !== params.accountId) {
      return null;
    }
    if (!currentSession.directUserId) {
      return null;
    }
    if (!currentSession.roomId || currentSession.roomId === params.roomId) {
      return null;
    }

    return [
      "This Matrix DM is sharing a session with another Matrix DM room.",
      "Set channels.matrix.dm.sessionScope to per-room to isolate each Matrix DM room.",
    ].join(" ");
  } catch (err) {
    params.logVerboseMessage(
      `matrix: failed checking shared DM session notice room=${params.roomId} (${String(err)})`,
    );
    return null;
  }
}

export function resolveMatrixPendingHistoryText(params: {
  mentionPrecheckText: string;
  content: RoomMessageEventContent;
  media: MatrixInboundMediaContent;
}): string {
  if (params.media.isGallery) {
    return formatMatrixGalleryText({
      caption: params.media.body,
      attachmentCount: params.media.attachmentCount,
    });
  }
  if (params.media.attachmentCount === 0) {
    return params.mentionPrecheckText;
  }
  const body = typeof params.content.body === "string" ? params.content.body : undefined;
  const filename =
    typeof params.content.filename === "string" ? params.content.filename : undefined;
  const msgtype = typeof params.content.msgtype === "string" ? params.content.msgtype : undefined;
  return formatMatrixMessageText({ body, filename, msgtype }) ?? params.mentionPrecheckText;
}

export type MatrixInboundMediaItem = {
  url: string;
  file?: EncryptedFile;
  contentType?: string;
  sizeBytes?: number;
  originalFilename?: string;
};

export type MatrixInboundMediaContent = {
  /** Message text; for a gallery this is the caption. */
  body: string;
  /** Downloadable `mxc://` attachments in event order: one for a media message, up to the cap for a gallery. */
  items: MatrixInboundMediaItem[];
  /** Attachments the event declares, including gallery entries that cannot be downloaded. */
  attachmentCount: number;
  isGallery: boolean;
};

// MSC4274 galleries (unstable prefix `dm.filament.gallery`, stable `m.gallery`) carry their
// attachments in `itemtypes`; each entry has the content shape of the matching media message.
const MATRIX_GALLERY_MSGTYPES = new Set(["dm.filament.gallery", "m.gallery"]);
const MATRIX_GALLERY_ITEMTYPES = new Set(["m.image", "m.video", "m.audio", "m.file"]);
// The event size limit does not bound the entry count (about 40 bytes per minimal entry), so
// galleries download at most as many items as the image tool accepts (DEFAULT_MAX_IMAGES).
// Entries over the cap stay in the declared count and are reported as unavailable.
const MATRIX_GALLERY_MAX_ITEMS = 20;

function resolveMatrixMediaItem(
  content: RoomMessageEventContent,
): MatrixInboundMediaItem | undefined {
  const file = content.file && typeof content.file === "object" ? content.file : undefined;
  const url = normalizeOptionalString(content.url) ?? normalizeOptionalString(file?.url);
  if (!url) {
    return undefined;
  }
  const info =
    content.info && typeof content.info === "object"
      ? (content.info as { mimetype?: string; size?: number })
      : undefined;
  return {
    url,
    file,
    contentType: info?.mimetype,
    sizeBytes: typeof info?.size === "number" ? info.size : undefined,
    originalFilename:
      normalizeOptionalString(content.filename) ?? normalizeOptionalString(content.body),
  };
}

export function resolveMatrixInboundMediaContent(
  content: RoomMessageEventContent,
): MatrixInboundMediaContent {
  const body = normalizeOptionalString(content.body) ?? "";
  if (!MATRIX_GALLERY_MSGTYPES.has(content.msgtype ?? "")) {
    const item = resolveMatrixMediaItem(content);
    return {
      body,
      // A non-mxc url still counts as media: the message is kept but nothing is downloaded.
      items: item?.url.startsWith("mxc://") ? [item] : [],
      attachmentCount: item ? 1 : 0,
      isGallery: false,
    };
  }
  const entries = Array.isArray(content.itemtypes) ? content.itemtypes : [];
  const items: MatrixInboundMediaItem[] = [];
  for (const entry of entries) {
    if (items.length >= MATRIX_GALLERY_MAX_ITEMS) {
      break;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    // SAFETY: wire JSON; itemtype and every media field are validated before use.
    const record = entry as RoomMessageEventContent;
    const item =
      typeof record.itemtype === "string" && MATRIX_GALLERY_ITEMTYPES.has(record.itemtype)
        ? resolveMatrixMediaItem(record)
        : undefined;
    if (item?.url.startsWith("mxc://")) {
      items.push(item);
    }
  }
  return { body, items, attachmentCount: entries.length, isGallery: true };
}

export function isMatrixAudioMediaEnabled(cfg: CoreConfig): boolean {
  return cfg.tools?.media?.audio?.enabled !== false;
}

/** Audio preflight applies to a lone audio message; a gallery's msgtype is never audio. */
export function resolveMatrixPreflightAudioItem(
  content: RoomMessageEventContent,
  media: MatrixInboundMediaContent,
): MatrixInboundMediaItem | undefined {
  const item = media.items[0];
  return item &&
    isMatrixAudioContent({
      msgtype: typeof content.msgtype === "string" ? content.msgtype : undefined,
      mimetype: item.contentType,
    })
    ? item
    : undefined;
}

export function shouldDeferMatrixAudioPreflightForRoomIngress(params: {
  content: RoomMessageEventContent;
  cfg: CoreConfig;
}): boolean {
  return (
    isMatrixAudioMediaEnabled(params.cfg) &&
    resolveMatrixPreflightAudioItem(
      params.content,
      resolveMatrixInboundMediaContent(params.content),
    ) !== undefined
  );
}

export function resolveMatrixAllowBotsMode(value?: boolean | "mentions"): MatrixAllowBotsMode {
  if (value === true) {
    return "all";
  }
  if (value === "mentions") {
    return "mentions";
  }
  return "off";
}

export function formatMatrixToolProgressMarkdownCode(text: string): string {
  const clipped =
    text.length <= MATRIX_TOOL_PROGRESS_MAX_CHARS
      ? text
      : `${truncateUtf16Safe(text, MATRIX_TOOL_PROGRESS_MAX_CHARS - 1).trimEnd()}...`;
  const safe = clipped.replaceAll("`", "'");
  return `\`${safe}\``;
}
