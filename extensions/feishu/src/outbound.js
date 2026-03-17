import fs from "fs";
import path from "path";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu, sendStructuredCardFeishu } from "./send.js";
function normalizePossibleLocalImagePath(text) {
  const raw = text?.trim();
  if (!raw) return null;
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;
  const ext = path.extname(raw).toLowerCase();
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext
  );
  if (!isImageExt) return null;
  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
    return null;
  }
  return raw;
}
function shouldUseCard(text) {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}
function resolveReplyToMessageId(params) {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return void 0;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || void 0;
}
async function sendOutboundText(params) {
  const { cfg, to, text, accountId, replyToMessageId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";
  if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) {
    return sendMarkdownCardFeishu({ cfg, to, text, accountId, replyToMessageId });
  }
  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
}
const feishuOutbound = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4e3,
  sendText: async ({
    cfg,
    to,
    text,
    accountId,
    replyToId,
    threadId,
    mediaLocalRoots,
    identity
  }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    const localImagePath = normalizePossibleLocalImagePath(text);
    if (localImagePath) {
      try {
        const result2 = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? void 0,
          replyToMessageId,
          mediaLocalRoots
        });
        return { channel: "feishu", ...result2 };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
      }
    }
    const account = resolveFeishuAccount({ cfg, accountId: accountId ?? void 0 });
    const renderMode = account.config?.renderMode ?? "auto";
    const useCard = renderMode === "card" || renderMode === "auto" && shouldUseCard(text);
    if (useCard) {
      const header = identity ? {
        title: identity.emoji ? `${identity.emoji} ${identity.name ?? ""}`.trim() : identity.name ?? "",
        template: "blue"
      } : void 0;
      const result2 = await sendStructuredCardFeishu({
        cfg,
        to,
        text,
        replyToMessageId,
        replyInThread: threadId != null && !replyToId,
        accountId: accountId ?? void 0,
        header: header?.title ? header : void 0
      });
      return { channel: "feishu", ...result2 };
    }
    const result = await sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? void 0,
      replyToMessageId
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
    threadId
  }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    if (text?.trim()) {
      await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? void 0,
        replyToMessageId
      });
    }
    if (mediaUrl) {
      try {
        const result2 = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? void 0,
          mediaLocalRoots,
          replyToMessageId
        });
        return { channel: "feishu", ...result2 };
      } catch (err) {
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        const fallbackText = `\u{1F4CE} ${mediaUrl}`;
        const result2 = await sendOutboundText({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? void 0,
          replyToMessageId
        });
        return { channel: "feishu", ...result2 };
      }
    }
    const result = await sendOutboundText({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? void 0,
      replyToMessageId
    });
    return { channel: "feishu", ...result };
  }
};
export {
  feishuOutbound
};
