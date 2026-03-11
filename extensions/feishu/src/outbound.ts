import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { detectFileType, sendFileFeishu, sendMediaFeishu, uploadFileFeishu } from "./media.js";
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

type FeishuSendPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  filename?: string;
};

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
  sendPayload: async (ctx) => {
    const payload = (ctx.payload ?? {}) as FeishuSendPayload;
    const text = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];

    if (mediaUrls.length > 0) {
      let lastResult;
      const filenameOverride =
        typeof payload.filename === "string" && payload.filename.trim()
          ? payload.filename.trim()
          : undefined;
      lastResult = await feishuOutbound.sendMedia!({
        ...ctx,
        text,
        mediaUrl: mediaUrls[0],
        payload: {
          ...payload,
          filename: filenameOverride,
        } as any,
      } as any);
      for (let i = 1; i < mediaUrls.length; i++) {
        lastResult = await feishuOutbound.sendMedia!({
          ...ctx,
          text: "",
          mediaUrl: mediaUrls[i],
          payload: {
            ...payload,
            filename: filenameOverride,
          } as any,
        } as any);
      }
      return lastResult;
    }

    return await feishuOutbound.sendText!({
      ...ctx,
      text,
    } as any);
  },
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
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
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
          replyToMessageId,
          mediaLocalRoots,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
        // fall through to plain text as last resort
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
      const result = await sendStructuredCardFeishu({
        cfg,
        to,
        text,
        replyToMessageId,
        replyInThread: threadId != null && !replyToId,
        accountId: accountId ?? undefined,
        header: header?.title ? header : undefined,
      });
      return { channel: "feishu", ...result };
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
    filename,
    accountId,
    mediaLocalRoots,
    replyToId,
    threadId,
    payload,
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
        const filenameOverride =
          typeof payload?.filename === "string" && payload.filename.trim()
            ? payload.filename.trim()
            : typeof filename === "string" && filename.trim()
              ? filename.trim()
              : undefined;
        const effectiveFileName = filenameOverride ?? path.basename(mediaUrl);
        const ext = path.extname(effectiveFileName).toLowerCase();
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
        const isLocalPath =
          path.isAbsolute(mediaUrl) && !/^(https?:\/\/|data:|file:\/\/)/i.test(mediaUrl);

        if (isLocalPath && !isImage) {
          const fileType = detectFileType(effectiveFileName);
          const { fileKey } = await uploadFileFeishu({
            cfg,
            file: mediaUrl,
            fileName: effectiveFileName,
            fileType,
            accountId: accountId ?? undefined,
          });
          const msgType = fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file";
          const result = await sendFileFeishu({
            cfg,
            to,
            fileKey,
            msgType,
            replyToMessageId,
            accountId: accountId ?? undefined,
          });
          return { channel: "feishu", ...result };
        }

        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          fileName: filenameOverride,
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
