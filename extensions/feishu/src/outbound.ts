import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getStreamAppender } from "./active-streams.js";
import { sendMediaFeishu, uploadImageFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";
import { normalizeFeishuTarget } from "./targets.js";

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;

  const ext = path.extname(raw).toLowerCase();
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) return null;

  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const normalizedTo = normalizeFeishuTarget(to);

    // Scheme A compatibility shim:
    // when upstream accidentally returns a local image path as plain text,
    // auto-upload and send as Feishu image message instead of leaking path text.
    const localImagePath = normalizePossibleLocalImagePath(text);
    if (localImagePath) {
      // If streaming is active, upload image and embed in card
      const appender = normalizedTo ? getStreamAppender(normalizedTo) : undefined;
      if (appender) {
        try {
          const buf = await fs.promises.readFile(localImagePath);
          const { imageKey } = await uploadImageFeishu({
            cfg,
            image: buf,
            accountId: accountId ?? undefined,
          });
          appender(`\n![image](${imageKey})\n`);
          return { channel: "feishu" };
        } catch {
          // fall through to separate message
        }
      }
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
        // fall through to plain text as last resort
      }
    }

    // If streaming is active, append text to card instead of sending separate message
    const appender = normalizedTo ? getStreamAppender(normalizedTo) : undefined;
    if (appender) {
      appender(text);
      return { channel: "feishu" };
    }

    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots }) => {
    const normalizedTo = normalizeFeishuTarget(to);
    const appender = normalizedTo ? getStreamAppender(normalizedTo) : undefined;

    // When streaming is active, embed everything in the card
    if (appender) {
      if (text?.trim()) {
        appender(text);
      }
      if (mediaUrl) {
        try {
          const mediaMaxBytes = 30 * 1024 * 1024;
          const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
            maxBytes: mediaMaxBytes,
            optimizeImages: false,
            localRoots: mediaLocalRoots?.length ? [...mediaLocalRoots] : undefined,
          });
          const ext = path.extname(loaded.fileName ?? "file").toLowerCase();
          const isImage = [
            ".jpg",
            ".jpeg",
            ".png",
            ".gif",
            ".webp",
            ".bmp",
            ".ico",
            ".tiff",
          ].includes(ext);

          if (isImage) {
            const { imageKey } = await uploadImageFeishu({
              cfg,
              image: loaded.buffer,
              accountId: accountId ?? undefined,
            });
            appender(`\n![image](${imageKey})\n`);
          } else {
            appender(`\n📎 [${loaded.fileName ?? "file"}](${mediaUrl})\n`);
          }
        } catch (err) {
          console.error(`[feishu] stream media embed failed:`, err);
          appender(`\n📎 ${mediaUrl}\n`);
        }
      }
      return { channel: "feishu" };
    }

    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    }

    // Upload and send media if URL or local path provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
          mediaLocalRoots,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageFeishu({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
