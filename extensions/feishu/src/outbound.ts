import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getStreamAppender } from "./active-streams.js";
import { sendMediaFeishu, uploadImageFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"]);

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
  if (!IMAGE_EXTS.has(ext)) return null;

  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
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
    const appender = getStreamAppender(to);

    // Auto-convert local image path to image message
    const localImagePath = normalizePossibleLocalImagePath(text);
    if (localImagePath) {
      try {
        if (appender) {
          const imageData = fs.readFileSync(localImagePath);
          const { imageKey } = await uploadImageFeishu({
            cfg,
            image: imageData,
            accountId: accountId ?? undefined,
          });
          appender(`\n![image](${imageKey})\n`);
          return { channel: "feishu", messageId: "", chatId: to };
        }
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
      }
    }

    if (appender) {
      appender(`\n\n${text}`);
      return { channel: "feishu", messageId: "", chatId: to };
    }
    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots }) => {
    const appender = getStreamAppender(to);

    if (appender) {
      // Streaming active: embed everything into the card
      if (mediaUrl) {
        try {
          const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
            maxBytes: 30 * 1024 * 1024,
            optimizeImages: false,
          });
          const ext = path.extname(loaded.fileName ?? "file").toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
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
          console.error(`[feishu] streaming media embed failed:`, err);
          appender(`\n📎 ${mediaUrl}\n`);
        }
      }
      if (text?.trim()) {
        appender(`\n\n${text}`);
      }
      return { channel: "feishu", messageId: "", chatId: to };
    }

    // No active stream: send normally
    if (text?.trim()) {
      await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    }
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
        console.error(`[feishu] sendMediaFeishu failed:`, err);
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

    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
