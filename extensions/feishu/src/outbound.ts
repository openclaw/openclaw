import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";

/**
 * Supported file extensions for auto-detecting local file paths in plain text.
 * Includes images and common document/media types supported by Feishu upload API.
 */
const AUTO_SEND_EXTENSIONS = new Set([
  // Images
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tiff",
  // Documents
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  // Audio/Video
  ".opus",
  ".mp4",
]);

function normalizePossibleLocalFilePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;

  const ext = path.extname(raw).toLowerCase();
  if (!AUTO_SEND_EXTENSIONS.has(ext)) return null;

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

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function resolveReplyToMessageId(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return undefined;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || undefined;
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  accountId?: string;
}) {
  const { cfg, to, text, accountId, replyToMessageId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    return sendMarkdownCardFeishu({ cfg, to, text, accountId, replyToMessageId });
  }

  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    // Scheme A compatibility shim:
    // when upstream accidentally returns a local file path as plain text,
    // auto-upload and send as Feishu file/image message instead of leaking path text.
    const localFilePath = normalizePossibleLocalFilePath(text);
    if (localFilePath) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localFilePath,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local file path auto-send failed:`, err);
        // fall through to plain text as last resort
      }
    }

    const result = await sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    accountId,
    mediaLocalRoots,
    replyToId,
    threadId,
  }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    // Send text first if provided
    if (text?.trim()) {
      await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
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
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendOutboundText({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendOutboundText({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    return { channel: "feishu", ...result };
  },
};
