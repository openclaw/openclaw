import type { PluginRuntime } from "openclaw/plugin-sdk";
import { createPumbleClient } from "./client.js";

/** Subset of Pumble webhook file attachment fields (short-form keys). */
export type PumbleNotificationMessageFile = {
  /** File ID (Pumble uses `fId` in webhook payloads). */
  fId?: string;
  /** File name. */
  n?: string;
  /** MIME type. */
  mt?: string;
  /** File size in bytes. */
  sz?: number;
  /** Direct download URL for the file (hosted on files.pumble.com). */
  p?: string;
};

export type MediaInfo = {
  path: string;
  contentType?: string;
  kind: string;
};

export function mediaKindFromMime(mime?: string | null): string {
  if (!mime) {
    return "unknown";
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  return "document";
}

export function buildPumbleAttachmentPlaceholder(mediaList: MediaInfo[]): string {
  if (mediaList.length === 0) {
    return "";
  }
  if (mediaList.length === 1) {
    const kind = mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind;
    return `<media:${kind}>`;
  }
  const allImages = mediaList.every((media) => media.kind === "image");
  const label = allImages ? "image" : "file";
  const suffix = `${label}s`; // length is always >= 2 here (single items early-return above)
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${mediaList.length} ${suffix})`;
}

/**
 * Resolve inbound file attachments into media info objects.
 * Downloads each file via the Pumble API, saves it locally, and returns
 * metadata for building `<media:*>` placeholders.
 */
export async function resolvePumbleMedia(
  files: PumbleNotificationMessageFile[] | null | undefined,
  deps: {
    botToken: string;
    appKey?: string;
    core: PluginRuntime;
    mediaMaxBytes: number | undefined;
    logVerboseMessage: (msg: string) => void;
  },
): Promise<MediaInfo[]> {
  const items = (files ?? []).filter((f): f is PumbleNotificationMessageFile & { fId: string } =>
    Boolean(f?.fId),
  );
  if (items.length === 0) {
    return [];
  }
  const client = createPumbleClient({ botToken: deps.botToken, appKey: deps.appKey });
  const out: MediaInfo[] = [];
  for (const file of items) {
    try {
      // Use the direct file URL (`p` field) from the webhook payload when available,
      // falling back to the REST API endpoint. The REST `/v1/files/{fId}` endpoint
      // returns 404 for app-scoped bot tokens, but the direct URL works with the
      // same auth headers.
      const downloadUrl = file.p ?? `${client.apiBase}/v1/files/${file.fId}`;
      deps.logVerboseMessage(`pumble: downloading file ${file.fId} from ${downloadUrl}`);
      const fetched = await deps.core.channel.media.fetchRemoteMedia({
        url: downloadUrl,
        requestInit: {
          headers: client.getAuthHeaders(),
        },
        filePathHint: file.n ?? file.fId,
        maxBytes: deps.mediaMaxBytes,
      });
      const saved = await deps.core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? undefined,
        "inbound",
        deps.mediaMaxBytes,
      );
      const contentType = saved.contentType ?? fetched.contentType ?? undefined;
      out.push({
        path: saved.path,
        contentType,
        kind: mediaKindFromMime(contentType),
      });
    } catch (err) {
      deps.logVerboseMessage(`pumble: failed to download file ${file.fId}: ${String(err)}`);
    }
  }
  return out;
}
