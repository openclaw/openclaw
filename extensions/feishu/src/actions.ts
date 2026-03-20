import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ClawdbotConfig,
} from "openclaw/plugin-sdk/feishu";
import { extractToolSend, jsonResult, readStringParam } from "openclaw/plugin-sdk/feishu";
import { listFeishuAccountIds, resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { sendOutboundText } from "./outbound.js";

const providerId = "feishu";

function listEnabledAccounts(cfg: ClawdbotConfig) {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}

function decodeBase64Payload(raw: string): { buffer: Buffer; contentType?: string } {
  const trimmed = raw.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/s.exec(trimmed);
  const base64 = dataUrlMatch ? dataUrlMatch[2] : trimmed;
  const contentType = dataUrlMatch?.[1];
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    throw new Error("buffer decoded to empty payload");
  }
  return { buffer, contentType };
}

function inferImageFileName(params: {
  fileName?: string;
  contentType?: string;
  mediaUrl?: string;
}): string {
  if (params.fileName?.trim()) {
    return params.fileName.trim();
  }

  const mediaUrl = params.mediaUrl?.trim();
  if (mediaUrl) {
    const lastSegment = mediaUrl.split(/[\\/]/).pop()?.trim();
    if (lastSegment) {
      return lastSegment;
    }
  }

  const type = params.contentType?.toLowerCase();
  if (type === "image/jpeg") return "image.jpg";
  if (type === "image/png") return "image.png";
  if (type === "image/webp") return "image.webp";
  if (type === "image/gif") return "image.gif";
  if (type === "image/bmp") return "image.bmp";
  if (type === "image/tiff") return "image.tiff";
  if (type === "image/x-icon" || type === "image/vnd.microsoft.icon") return "image.ico";
  if (type?.startsWith("image/")) {
    return `image.${type.slice("image/".length)}`;
  }
  return "file";
}

function resolveReplyToMessageId(params: Record<string, unknown>): string | undefined {
  const replyTo = readStringParam(params, "replyTo");
  if (replyTo) {
    return replyTo;
  }
  const threadId = readStringParam(params, "threadId");
  return threadId || undefined;
}

export const feishuMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    return ["send"] satisfies ChannelMessageActionName[];
  },
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId, mediaLocalRoots }) => {
    if (action !== "send") {
      throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
    }

    const to = readStringParam(params, "to", { required: true });
    const message =
      readStringParam(params, "message", {
        allowEmpty: true,
      }) ?? "";
    const mediaUrl =
      readStringParam(params, "media", { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, "filePath", { trim: false });
    const rawBuffer = readStringParam(params, "buffer", { trim: false });
    const fileName = readStringParam(params, "filename");
    const contentType =
      readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
    const replyToMessageId = resolveReplyToMessageId(params);

    if (!message.trim() && !mediaUrl && !rawBuffer) {
      throw new Error("send requires text or media");
    }

    let textResult: Awaited<ReturnType<typeof sendOutboundText>> | undefined;
    if (message.trim()) {
      textResult = await sendOutboundText({
        cfg,
        to,
        text: message,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    }

    if (rawBuffer) {
      const decoded = decodeBase64Payload(rawBuffer);
      const result = await sendMediaFeishu({
        cfg,
        to,
        mediaBuffer: decoded.buffer,
        fileName: inferImageFileName({
          fileName,
          contentType: contentType ?? decoded.contentType,
          mediaUrl,
        }),
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
      return jsonResult({ ok: true, to, messageId: result.messageId, chatId: result.chatId });
    }

    if (mediaUrl) {
      const result = await sendMediaFeishu({
        cfg,
        to,
        mediaUrl,
        fileName: inferImageFileName({ fileName, contentType, mediaUrl }),
        accountId: accountId ?? undefined,
        replyToMessageId,
        mediaLocalRoots,
      });
      return jsonResult({ ok: true, to, messageId: result.messageId, chatId: result.chatId });
    }

    return jsonResult({
      ok: true,
      to,
      messageId: textResult?.messageId,
      chatId: textResult?.chatId,
    });
  },
};
