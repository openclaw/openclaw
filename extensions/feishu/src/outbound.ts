import fs from "fs";
import path from "path";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelOutboundAdapter } from "../runtime-api.js";
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

/** Markdown image pattern: ![alt](url) — only HTTP(S) URLs. */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/(?:[^)(]|\((?:[^)(]*)\))*)\)/g;

/**
 * Extract markdown image URLs from text and return cleaned text with
 * image references removed. Only extracts HTTP(S) URLs.
 * Skips images inside fenced code blocks to avoid mangling code examples.
 */
function extractMarkdownImageUrls(text: string): { imageUrls: string[]; cleanedText: string } {
  const imageUrls: string[] = [];
  // Split on fenced code blocks to avoid extracting images from code examples.
  const parts = text.split(/(```[\s\S]*?```)/g);
  const processed = parts.map((part, i) => {
    // Odd-indexed parts are fenced code blocks — leave them intact.
    if (i % 2 === 1) return part;
    return part.replace(MARKDOWN_IMAGE_RE, (_match, _alt: string, url: string) => {
      imageUrls.push(url);
      return "";
    });
  });
  const cleanedText = processed
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { imageUrls, cleanedText };
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
  replyInThread?: boolean;
  accountId?: string;
  identity?: { name?: string; emoji?: string };
}) {
  const { cfg, to, text, accountId, replyToMessageId, replyInThread, identity } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    const header = identity
      ? {
          title: identity.emoji
            ? `${identity.emoji} ${identity.name ?? ""}`.trim()
            : (identity.name ?? ""),
          template: "blue" as const,
        }
      : undefined;
    return sendStructuredCardFeishu({
      cfg,
      to,
      text,
      accountId,
      replyToMessageId,
      replyInThread,
      header: header?.title ? header : undefined,
    });
  }

  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
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
      // Scheme A compatibility shim:
      // when upstream accidentally returns a local image path as plain text,
      // auto-upload and send as Feishu image message instead of leaking path text.
      const localImagePath = normalizePossibleLocalImagePath(text);
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

      // Extract markdown image URLs from LLM output and upload as native
      // Feishu images instead of sending them as plain text links.
      const extracted = extractMarkdownImageUrls(text);
      if (extracted.imageUrls.length > 0) {
        let remainingText = extracted.cleanedText;
        let lastMediaResult: Awaited<ReturnType<typeof sendMediaFeishu>> | undefined;
        for (const url of extracted.imageUrls) {
          try {
            lastMediaResult = await sendMediaFeishu({
              cfg,
              to,
              mediaUrl: url,
              accountId: accountId ?? undefined,
              replyToMessageId,
              replyInThread: threadId != null && !replyToId,
              mediaLocalRoots,
            });
          } catch (err) {
            console.error(`[feishu] image URL upload failed for ${url}:`, err);
            // Preserve the URL as a plain link so the user still sees it.
            remainingText = [remainingText, `📎 ${url}`].filter(Boolean).join("\n\n");
          }
        }
        // Send remaining text if any content is left after removing image references.
        if (remainingText) {
          return await sendOutboundText({
            cfg,
            to,
            text: remainingText,
            accountId: accountId ?? undefined,
            replyToMessageId,
            replyInThread: threadId != null && !replyToId,
            identity,
          });
        }
        // Only images, no remaining text.
        if (lastMediaResult) {
          return lastMediaResult;
        }
      }

      const account = resolveFeishuAccount({ cfg, accountId: accountId ?? undefined });
      const renderMode = account.config?.renderMode ?? "auto";
      const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
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
          text,
          replyToMessageId,
          replyInThread: threadId != null && !replyToId,
          accountId: accountId ?? undefined,
          header: header?.title ? header : undefined,
        });
      }
      return await sendOutboundText({
        cfg,
        to,
        text,
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
      return await sendOutboundText({
        cfg,
        to,
        text: text ?? "",
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    },
  }),
};
