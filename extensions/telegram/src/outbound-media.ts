import { InputFile } from "grammy";
import type { Message } from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { extensionForMime, type MediaKind } from "openclaw/plugin-sdk/media-mime";
import { isGifMedia, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveTelegramPlainCaption, splitTelegramCaption } from "./caption.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import { isTelegramEmptyContentError, isTelegramHtmlParseError } from "./rich-plain-fallback.js";
import type { TelegramApi } from "./send-context.js";
import { resolveTelegramVoiceSend } from "./voice.js";

type TelegramLoadedMedia = Awaited<ReturnType<typeof loadWebMedia>>;

const MEDIA_SEND_METHODS = {
  animation: "sendAnimation",
  photo: "sendPhoto",
  video: "sendVideo",
  video_note: "sendVideoNote",
  voice: "sendVoice",
  audio: "sendAudio",
  document: "sendDocument",
} as const;

const DEFAULT_MEDIA_EXTENSIONS = { image: ".jpg", video: ".mp4", audio: ".ogg", file: ".bin" };

type TelegramOutboundMediaKind = keyof typeof MEDIA_SEND_METHODS;

export type TelegramOutboundMediaSender = {
  label: TelegramOutboundMediaKind;
  operation: string;
  send: (effectiveParams: Record<string, unknown>) => Promise<Message>;
};

function resolveTelegramOutboundMediaFilename(params: {
  fileName?: string;
  contentType?: string;
  kind?: MediaKind;
  isGif: boolean;
}): string {
  if (params.fileName) {
    return params.fileName;
  }
  if (params.isGif) {
    return "animation.gif";
  }

  // Telegram receives only the multipart filename, so preserve the detected
  // MIME extension instead of labeling every anonymous upload as another format.
  const basename =
    params.kind === "image" || params.kind === "video" || params.kind === "audio"
      ? params.kind
      : "file";
  return `${basename}${extensionForMime(params.contentType) ?? DEFAULT_MEDIA_EXTENSIONS[basename]}`;
}

export function prepareTelegramOutboundMedia(params: {
  media: TelegramLoadedMedia;
  text?: string;
  textMode?: "markdown" | "html";
  tableMode?: MarkdownTableMode;
  forceDocument?: boolean;
  asVideoNote?: boolean;
  preparedHtml?: boolean;
}) {
  const kind = kindFromMime(params.media.contentType ?? undefined);
  const isGif = isGifMedia({
    contentType: params.media.contentType,
    fileName: params.media.fileName,
  });
  const deliveryKind =
    params.forceDocument === true && (kind === "image" || kind === "video") ? "document" : kind;
  if (params.asVideoNote === true && deliveryKind !== "video") {
    throw new Error("Telegram video notes require video media.");
  }
  const isVideoNote = deliveryKind === "video" && params.asVideoNote === true;
  const fileName = resolveTelegramOutboundMediaFilename({
    fileName: params.media.fileName,
    contentType: params.media.contentType,
    kind,
    isGif,
  });
  const text = params.text;
  const trimmedText = text?.trim();
  const renderedCaption =
    !isVideoNote && trimmedText
      ? params.preparedHtml === true && params.textMode === "html"
        ? trimmedText
        : renderTelegramHtmlText(trimmedText, {
            textMode: params.textMode ?? "markdown",
            tableMode: params.tableMode,
          })
      : undefined;
  const { caption, followUpText } = isVideoNote
    ? { caption: undefined, followUpText: trimmedText ? text : undefined }
    : splitTelegramCaption(text, renderedCaption);
  const htmlCaption = caption ? renderedCaption : undefined;

  return {
    kind,
    deliveryKind,
    isGif,
    isVideoNote,
    fileName,
    file: new InputFile(params.media.buffer, fileName),
    htmlCaption,
    plainCaption: resolveTelegramPlainCaption(
      caption && params.textMode === "html" ? telegramHtmlToPlainTextFallback(caption) : caption,
      htmlCaption,
    ),
    followUpText,
  };
}

export function resolveTelegramOutboundMediaSenders(params: {
  api: TelegramApi;
  chatId: string;
  media: TelegramLoadedMedia;
  plan: ReturnType<typeof prepareTelegramOutboundMedia>;
  forceDocument?: boolean;
  asVoice?: boolean;
  sendImageAsPhoto?: boolean;
}): { sender: TelegramOutboundMediaSender; documentSender: TelegramOutboundMediaSender } {
  const createSender = (label: TelegramOutboundMediaKind): TelegramOutboundMediaSender => {
    const operation = MEDIA_SEND_METHODS[label];
    const method: (
      chatId: string,
      file: InputFile,
      options: Record<string, unknown>,
    ) => Promise<Message> = params.api[operation];
    return {
      label,
      operation,
      send: (effectiveParams) =>
        method.call(
          params.api,
          params.chatId,
          params.plan.file,
          label === "document" && params.forceDocument
            ? { ...effectiveParams, disable_content_type_detection: true }
            : effectiveParams,
        ),
    };
  };
  const documentSender = createSender("document");
  let label: TelegramOutboundMediaKind = "document";
  if (params.plan.isGif && params.plan.deliveryKind !== "document") {
    label = "animation";
  } else if (params.plan.deliveryKind === "image" && params.sendImageAsPhoto !== false) {
    label = "photo";
  } else if (params.plan.deliveryKind === "video") {
    label = params.plan.isVideoNote ? "video_note" : "video";
  } else if (params.plan.kind === "audio") {
    const { useVoice } = resolveTelegramVoiceSend({
      wantsVoice: params.asVoice === true,
      contentType: params.media.contentType,
      fileName: params.plan.fileName,
      logFallback: logVerbose,
    });
    label = useVoice ? "voice" : "audio";
  }
  return { sender: label === "document" ? documentSender : createSender(label), documentSender };
}

export async function sendTelegramCaptionedMediaWithFallback<T>(params: {
  operation: string;
  requestParams: Record<string, unknown>;
  plainCaption?: string;
  shouldLog?: (err: unknown) => boolean;
  send: (
    requestParams: Record<string, unknown>,
    shouldLog?: (err: unknown) => boolean,
  ) => Promise<T>;
}): Promise<{ result: T; deliveredCaption?: string; captionRemoved?: true }> {
  const requestCaption =
    typeof params.requestParams.caption === "string" ? params.requestParams.caption : undefined;
  let requestParams = params.requestParams;
  let usingPlainCaption = false;
  let deliveredCaption =
    requestCaption !== undefined ? (params.plainCaption ?? requestCaption) : undefined;
  for (;;) {
    try {
      return {
        result: await params.send(
          requestParams,
          (err) =>
            (usingPlainCaption || !isTelegramHtmlParseError(err)) &&
            !isTelegramEmptyContentError(err) &&
            (params.shouldLog?.(err) ?? true),
        ),
        ...(deliveredCaption !== undefined ? { deliveredCaption } : {}),
      };
    } catch (err) {
      if (isTelegramEmptyContentError(err) && (usingPlainCaption || requestCaption !== undefined)) {
        const captionlessParams = { ...params.requestParams };
        delete captionlessParams.caption;
        delete captionlessParams.parse_mode;
        return {
          result: await params.send(captionlessParams, params.shouldLog),
          ...(requestCaption !== undefined ? { captionRemoved: true as const } : {}),
        };
      }
      if (usingPlainCaption || !isTelegramHtmlParseError(err) || !params.plainCaption) {
        throw err;
      }
      // Captions share the text-send contract: retain visible content after an
      // HTML parse failure without disturbing the topic, quote, or keyboard.
      logVerbose(
        `telegram ${params.operation} caption HTML rejected; retrying as plain caption: ${formatErrorMessage(
          err,
        )}`,
      );
      requestParams = { ...params.requestParams, caption: params.plainCaption };
      delete requestParams.parse_mode;
      deliveredCaption = params.plainCaption;
      usingPlainCaption = true;
    }
  }
}
