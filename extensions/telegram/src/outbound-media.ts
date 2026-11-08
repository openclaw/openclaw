import { InputFile } from "grammy";
import type { Message } from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isGifMedia, kindFromMime, runFfprobe } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
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

async function probeAudioDurationMs(buffer: Buffer): Promise<number | undefined> {
  try {
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "telegram-audio-" },
      async (workspace) => {
        const file = await workspace.write("audio", buffer);
        const duration = Number(
          await runFfprobe([
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "ogg,mp3,mov",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            file,
          ]),
        );
        return Number.isFinite(duration) && duration > 0 ? duration * 1000 : undefined;
      },
    );
  } catch {
    return undefined;
  }
}

export type TelegramOutboundMediaSender = {
  label: TelegramOutboundMediaKind;
  operation: string;
  send: (effectiveParams: Record<string, unknown>) => Promise<Message>;
};

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
  const basename = kind === "image" || kind === "video" || kind === "audio" ? kind : "file";
  // Telegram receives only the multipart filename; retain the detected MIME extension.
  const fileName =
    params.media.fileName ||
    (isGif
      ? "animation.gif"
      : `${basename}${extensionForMime(params.media.contentType) ?? DEFAULT_MEDIA_EXTENSIONS[basename]}`);
  const text = params.text;
  const trimmedText = text?.trim();
  const renderedCaption =
    !isVideoNote && trimmedText
      ? params.preparedHtml === true && params.textMode === "html"
        ? trimmedText
        : renderTelegramHtmlText(trimmedText, {
            textMode: params.textMode ?? "markdown",
            tableMode: params.tableMode,
            downgradeRichPromptTags: true,
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
  let audioDurationMsPromise: Promise<number | undefined> | undefined;
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
      send: async (effectiveParams) => {
        // Telegram shows 0:00 for some voice/audio uploads unless duration is explicit.
        const durationMs =
          label === "voice" || label === "audio"
            ? await (audioDurationMsPromise ??= probeAudioDurationMs(params.media.buffer))
            : undefined;
        return await method.call(params.api, params.chatId, params.plan.file, {
          ...effectiveParams,
          ...(durationMs ? { duration: Math.max(1, Math.round(durationMs / 1000)) } : {}),
          ...(label === "document" && params.forceDocument
            ? { disable_content_type_detection: true }
            : {}),
        });
      },
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
