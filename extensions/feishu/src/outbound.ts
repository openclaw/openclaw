import fs from "fs";
import path from "path";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { isSilentReplyText, stripSilentToken } from "../../../src/auto-reply/tokens.js";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu, sendStructuredCardFeishu } from "./send.js";

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

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function normalizeFeishuOutboundText(text: string | undefined): string {
  if (!text) return "";
  if (isSilentReplyText(text)) {
    return "";
  }
  if (text.includes("NO_REPLY")) {
    return stripSilentToken(text);
  }
  return text;
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
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  ...createAttachedChannelResultAdapter({
    channel: "feishu",
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      threadId,
      mediaLocalRoots,
      identity,
    }) => {
      const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
      const normalizedText = normalizeFeishuOutboundText(text);
      // Scheme A compatibility shim:
      // when upstream accidentally returns a local image path as plain text,
      // auto-upload and send as Feishu image message instead of leaking path text.
      const localImagePath = normalizePossibleLocalImagePath(normalizedText);
      if (localImagePath) {
        try {
          return await sendMediaFeishu({
            cfg,
            to,
            mediaUrl: localImagePath,
            accountId: accountId ?? undefined,
            replyToMessageId,
            mediaLocalRoots,
          });
        } catch (err) {
          console.error(`[feishu] local image path auto-send failed:`, err);
          // fall through to plain text as last resort
        }
      }

      if (!normalizedText.trim()) {
        return { channel: "feishu", messageId: "suppressed" };
      }

      const account = resolveFeishuAccount({ cfg, accountId: accountId ?? undefined });
      const renderMode = account.config?.renderMode ?? "auto";
      const useCard =
        renderMode === "card" || (renderMode === "auto" && shouldUseCard(normalizedText));
      if (useCard) {
        const header = identity
          ? {
              title: identity.emoji
                ? `${identity.emoji} ${identity.name ?? ""}`.trim()
                : (identity.name ?? ""),
              template: "blue" as const,
            }
          : undefined;
        return await sendStructuredCardFeishu({
          cfg,
          to,
          text: normalizedText,
          replyToMessageId,
          replyInThread: threadId != null && !replyToId,
          accountId: accountId ?? undefined,
          header: header?.title ? header : undefined,
        });
      }
      return await sendOutboundText({
        cfg,
        to,
        text: normalizedText,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
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
      const normalizedText = normalizeFeishuOutboundText(text);
      // Send text first if provided
      if (normalizedText.trim()) {
        await sendOutboundText({
          cfg,
          to,
          text: normalizedText,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
      }

      // Upload and send media if URL or local path provided
      if (mediaUrl) {
        try {
          return await sendMediaFeishu({
            cfg,
            to,
            mediaUrl,
            accountId: accountId ?? undefined,
            mediaLocalRoots,
            replyToMessageId,
          });
        } catch (err) {
          // Log the error for debugging
          console.error(`[feishu] sendMediaFeishu failed:`, err);
          // Fallback to URL link if upload fails
          return await sendOutboundText({
            cfg,
            to,
            text: `📎 ${mediaUrl}`,
            accountId: accountId ?? undefined,
            replyToMessageId,
          });
        }
      }

      // No media URL, just return text result
      if (!mediaUrl && !normalizedText.trim()) {
        return { channel: "feishu", messageId: "suppressed" };
      }

      return await sendOutboundText({
        cfg,
        to,
        text: normalizedText,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    },
  }),
};
