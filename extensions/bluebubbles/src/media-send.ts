import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { sendBlueBubblesAttachment } from "./attachments.js";
import { sendMessageBlueBubbles } from "./send.js";
import { getBlueBubblesRuntime } from "./runtime.js";

const HTTP_URL_RE = /^https?:\/\//i;

function resolveLocalMediaPath(source: string): string {
  if (!source.startsWith("file://")) return source;
  try {
    return fileURLToPath(source);
  } catch {
    throw new Error(`Invalid file:// URL: ${source}`);
  }
}

function resolveFilenameFromSource(source?: string): string | undefined {
  if (!source) return undefined;
  if (source.startsWith("file://")) {
    try {
      return path.basename(fileURLToPath(source)) || undefined;
    } catch {
      return undefined;
    }
  }
  if (HTTP_URL_RE.test(source)) {
    try {
      return path.basename(new URL(source).pathname) || undefined;
    } catch {
      return undefined;
    }
  }
  const base = path.basename(source);
  return base || undefined;
}

export async function sendBlueBubblesMedia(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl?: string;
  mediaPath?: string;
  mediaBuffer?: Uint8Array;
  contentType?: string;
  filename?: string;
  caption?: string;
  replyToId?: string | null;
  accountId?: string;
}) {
  const {
    cfg,
    to,
    mediaUrl,
    mediaPath,
    mediaBuffer,
    contentType,
    filename,
    caption,
    replyToId,
    accountId,
  } = params;
  const core = getBlueBubblesRuntime();

  let buffer: Uint8Array;
  let resolvedContentType = contentType ?? undefined;
  let resolvedFilename = filename ?? undefined;

  if (mediaBuffer) {
    buffer = mediaBuffer;
    if (!resolvedContentType) {
      const hint = mediaPath ?? mediaUrl;
      const detected = await core.media.detectMime({
        buffer: Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer),
        filePath: hint,
      });
      resolvedContentType = detected ?? undefined;
    }
    if (!resolvedFilename) {
      resolvedFilename = resolveFilenameFromSource(mediaPath ?? mediaUrl);
    }
  } else {
    const source = mediaPath ?? mediaUrl;
    if (!source) {
      throw new Error("BlueBubbles media delivery requires mediaUrl, mediaPath, or mediaBuffer.");
    }
    if (HTTP_URL_RE.test(source)) {
      const fetched = await core.channel.media.fetchRemoteMedia({ url: source });
      buffer = fetched.buffer;
      resolvedContentType = resolvedContentType ?? fetched.contentType ?? undefined;
      resolvedFilename = resolvedFilename ?? fetched.fileName;
    } else {
      const localPath = resolveLocalMediaPath(source);
      const fs = await import("node:fs/promises");
      const data = await fs.readFile(localPath);
      buffer = new Uint8Array(data);
      if (!resolvedContentType) {
        const detected = await core.media.detectMime({
          buffer: data,
          filePath: localPath,
        });
        resolvedContentType = detected ?? undefined;
      }
      if (!resolvedFilename) {
        resolvedFilename = resolveFilenameFromSource(localPath);
      }
    }
  }

  const attachmentResult = await sendBlueBubblesAttachment({
    to,
    buffer,
    filename: resolvedFilename ?? "attachment",
    contentType: resolvedContentType ?? undefined,
    opts: {
      cfg,
      accountId,
    },
  });

  const trimmedCaption = caption?.trim();
  if (trimmedCaption) {
    await sendMessageBlueBubbles(to, trimmedCaption, {
      cfg,
      accountId,
      replyToMessageGuid: replyToId?.trim() || undefined,
    });
  }

  return attachmentResult;
}
