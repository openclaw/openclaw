import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { fetchMediaWithZaloSendContext } from "./send-context.js";
import { createZalouserSendReceipt } from "./send-receipt.js";
import type { ZaloSendOptions, ZaloSendResult } from "./types.js";
import type { API } from "./zca-client.js";
import { TextStyle, ThreadType } from "./zca-constants.js";

function clampTextStyles(
  text: string,
  styles?: ZaloSendOptions["textStyles"],
): ZaloSendOptions["textStyles"] {
  if (!styles || styles.length === 0) {
    return undefined;
  }
  const maxLength = text.length;
  const clamped = styles
    .map((style) => {
      const start = Math.max(0, Math.min(style.start, maxLength));
      const end = Math.min(style.start + style.len, maxLength);
      if (end <= start) {
        return null;
      }
      if (style.st === TextStyle.Indent) {
        return {
          start,
          len: end - start,
          st: style.st,
          indentSize: style.indentSize,
        };
      }
      return {
        start,
        len: end - start,
        st: style.st,
      };
    })
    .filter((style): style is NonNullable<typeof style> => style !== null);
  return clamped.length > 0 ? clamped : undefined;
}

function extractSendMessageId(result: Awaited<ReturnType<API["sendMessage"]>>): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const direct = result.msgId;
  if (direct !== undefined && direct !== null) {
    return String(direct);
  }
  const primary = result.message?.msgId;
  if (primary !== undefined && primary !== null) {
    return String(primary);
  }
  const attachmentId = result.attachment?.[0]?.msgId;
  if (attachmentId !== undefined && attachmentId !== null) {
    return String(attachmentId);
  }
  return undefined;
}

function resolveMediaFileName(params: {
  mediaUrl: string;
  fileName?: string;
  contentType?: string;
  kind?: string;
}): string {
  const explicit = params.fileName?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const parsed = new URL(params.mediaUrl);
    const fromPath = path.basename(parsed.pathname).trim();
    if (fromPath) {
      return fromPath;
    }
  } catch {
    // ignore URL parse failures
  }

  const ext =
    extensionForMime(params.contentType)?.replace(/^\./u, "") ??
    (params.kind === "video"
      ? "mp4"
      : params.kind === "audio"
        ? "mp3"
        : params.kind === "image"
          ? "jpg"
          : "bin");

  return `upload.${ext}`;
}

function hasAttachmentExtension(fileName: string): fileName is `${string}.${string}` {
  return fileName.includes(".");
}

function resolveUploadedVoiceAsset(
  uploaded: Array<{
    fileType?: string;
    fileUrl?: string;
    fileName?: string;
  }>,
): { fileUrl: string; fileName?: string } | undefined {
  for (const item of uploaded) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const fileType = normalizeOptionalLowercaseString(item.fileType);
    const fileUrl = item.fileUrl?.trim();
    if (!fileUrl) {
      continue;
    }
    if (fileType === "others" || fileType === "video") {
      return { fileUrl, fileName: normalizeOptionalString(item.fileName) };
    }
  }
  return undefined;
}

function buildZaloVoicePlaybackUrl(asset: { fileUrl: string; fileName?: string }): string {
  // zca-js uses uploadAttachment(...).fileUrl directly for sendVoice.
  // Appending filename can produce URLs that play only in the local session.
  return asset.fileUrl.trim();
}

function truncatePayloadText(text: string): string {
  return truncateUtf16Safe(text, 2000);
}

export async function sendZaloTextWithApi(
  api: API,
  trimmedThreadId: string,
  text: string,
  options: ZaloSendOptions,
  onDeliveryResult?: (result: ZaloSendResult) => Promise<void> | void,
): Promise<ZaloSendResult> {
  const type = options.isGroup ? ThreadType.Group : ThreadType.User;
  let textMessageId: string | undefined;

  try {
    if (options.mediaUrl?.trim()) {
      const media = await loadOutboundMediaFromUrl(options.mediaUrl.trim(), {
        maxBytes: options.mediaMaxBytes,
        mediaLocalRoots: options.mediaLocalRoots,
        mediaReadFile: options.mediaReadFile,
        fetchImpl: fetchMediaWithZaloSendContext,
      });
      const fileName = resolveMediaFileName({
        mediaUrl: options.mediaUrl,
        fileName: media.fileName,
        contentType: media.contentType,
        kind: media.kind,
      });
      const payloadText = truncatePayloadText(text || options.caption || "");
      const textStyles = clampTextStyles(payloadText, options.textStyles);

      if (media.kind === "audio") {
        if (payloadText) {
          const textResponse = await api.sendMessage(
            textStyles ? { msg: payloadText, styles: textStyles } : payloadText,
            trimmedThreadId,
            type,
          );
          textMessageId = extractSendMessageId(textResponse);
          await onDeliveryResult?.({
            ok: true,
            messageId: textMessageId,
            receipt: createZalouserSendReceipt({
              messageId: textMessageId,
              threadId: trimmedThreadId,
              kind: "text",
            }),
          });
        }

        const attachmentFileName: `${string}.${string}` = hasAttachmentExtension(fileName)
          ? fileName
          : `${fileName}.bin`;
        const uploaded = await api.uploadAttachment(
          [
            {
              data: media.buffer,
              filename: attachmentFileName,
              metadata: {
                totalSize: media.buffer.length,
              },
            },
          ],
          trimmedThreadId,
          type,
        );
        const voiceAsset = resolveUploadedVoiceAsset(uploaded);
        if (!voiceAsset) {
          throw new Error("Failed to resolve uploaded audio URL for voice message");
        }
        const voiceUrl = buildZaloVoicePlaybackUrl(voiceAsset);
        const response = await api.sendVoice({ voiceUrl }, trimmedThreadId, type);
        const voiceMessageId = extractSendMessageId(response);
        return {
          ok: true,
          messageId: voiceMessageId ?? textMessageId,
          receipt: createZalouserSendReceipt({
            platformMessageIds: [textMessageId, voiceMessageId],
            threadId: trimmedThreadId,
            kind: "voice",
          }),
        };
      }

      const response = await api.sendMessage(
        {
          msg: payloadText,
          ...(textStyles ? { styles: textStyles } : {}),
          attachments: [
            {
              data: media.buffer,
              filename: hasAttachmentExtension(fileName) ? fileName : `${fileName}.bin`,
              metadata: {
                totalSize: media.buffer.length,
              },
            },
          ],
        },
        trimmedThreadId,
        type,
      );
      const messageId = extractSendMessageId(response);
      return {
        ok: true,
        messageId,
        receipt: createZalouserSendReceipt({
          messageId,
          threadId: trimmedThreadId,
          kind: "media",
        }),
      };
    }

    const payloadText = truncatePayloadText(text);
    const textStyles = clampTextStyles(payloadText, options.textStyles);
    const response = await api.sendMessage(
      textStyles ? { msg: payloadText, styles: textStyles } : payloadText,
      trimmedThreadId,
      type,
    );
    const messageId = extractSendMessageId(response);
    return {
      ok: true,
      messageId,
      receipt: createZalouserSendReceipt({
        messageId,
        threadId: trimmedThreadId,
        kind: "text",
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatErrorMessage(error),
      receipt: createZalouserSendReceipt({
        messageId: textMessageId,
        threadId: trimmedThreadId,
        kind: textMessageId ? "text" : "unknown",
      }),
    };
  }
}
