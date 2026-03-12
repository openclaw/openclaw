import { parseZalouserTextStyles } from "./text-styles.js";
import type { ZaloEventMessage, ZaloSendOptions, ZaloSendResult } from "./types.js";
import {
  sendZaloDeliveredEvent,
  sendZaloLink,
  sendZaloReaction,
  sendZaloSeenEvent,
  sendZaloTextMessage,
  sendZaloTypingEvent,
} from "./zalo-js.js";
import { TextStyle } from "./zca-client.js";

export type ZalouserSendOptions = ZaloSendOptions;
export type ZalouserSendResult = ZaloSendResult;

const ZALO_TEXT_LIMIT = 2000;

type StyledTextChunk = {
  text: string;
  styles?: ZaloSendOptions["textStyles"];
};

export async function sendMessageZalouser(
  threadId: string,
  text: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  const prepared =
    options.textMode === "markdown"
      ? parseZalouserTextStyles(text)
      : { text, styles: options.textStyles };
  const chunks = splitStyledText(
    prepared.text,
    (prepared.styles?.length ?? 0) > 0 ? prepared.styles : undefined,
    ZALO_TEXT_LIMIT,
  );

  let lastResult: ZalouserSendResult | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const chunkOptions =
      index === 0
        ? { ...options, textStyles: chunk.styles }
        : {
            ...options,
            caption: undefined,
            mediaLocalRoots: undefined,
            mediaUrl: undefined,
            textStyles: chunk.styles,
          };
    const result = await sendZaloTextMessage(threadId, chunk.text, chunkOptions);
    if (!result.ok) {
      return result;
    }
    lastResult = result;
  }

  return lastResult ?? { ok: false, error: "No message content provided" };
}

export async function sendImageZalouser(
  threadId: string,
  imageUrl: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  return await sendMessageZalouser(threadId, options.caption ?? "", {
    ...options,
    caption: undefined,
    mediaUrl: imageUrl,
  });
}

export async function sendLinkZalouser(
  threadId: string,
  url: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  return await sendZaloLink(threadId, url, options);
}

export async function sendTypingZalouser(
  threadId: string,
  options: Pick<ZalouserSendOptions, "profile" | "isGroup"> = {},
): Promise<void> {
  await sendZaloTypingEvent(threadId, options);
}

export async function sendReactionZalouser(params: {
  threadId: string;
  msgId: string;
  cliMsgId: string;
  emoji: string;
  remove?: boolean;
  profile?: string;
  isGroup?: boolean;
}): Promise<ZalouserSendResult> {
  const result = await sendZaloReaction({
    profile: params.profile,
    threadId: params.threadId,
    isGroup: params.isGroup,
    msgId: params.msgId,
    cliMsgId: params.cliMsgId,
    emoji: params.emoji,
    remove: params.remove,
  });
  return {
    ok: result.ok,
    error: result.error,
  };
}

export async function sendDeliveredZalouser(params: {
  profile?: string;
  isGroup?: boolean;
  message: ZaloEventMessage;
  isSeen?: boolean;
}): Promise<void> {
  await sendZaloDeliveredEvent(params);
}

export async function sendSeenZalouser(params: {
  profile?: string;
  isGroup?: boolean;
  message: ZaloEventMessage;
}): Promise<void> {
  await sendZaloSeenEvent(params);
}

function splitStyledText(
  text: string,
  styles: ZaloSendOptions["textStyles"],
  limit: number,
): StyledTextChunk[] {
  if (text.length === 0) {
    return [{ text, styles: undefined }];
  }

  const chunks: StyledTextChunk[] = [];
  for (let start = 0; start < text.length; start += limit) {
    const end = Math.min(text.length, start + limit);
    chunks.push({
      text: text.slice(start, end),
      styles: sliceTextStyles(styles, start, end),
    });
  }
  return chunks;
}

function sliceTextStyles(
  styles: ZaloSendOptions["textStyles"],
  start: number,
  end: number,
): ZaloSendOptions["textStyles"] {
  if (!styles || styles.length === 0) {
    return undefined;
  }

  const chunkStyles = styles
    .map((style) => {
      const overlapStart = Math.max(style.start, start);
      const overlapEnd = Math.min(style.start + style.len, end);
      if (overlapEnd <= overlapStart) {
        return null;
      }

      if (style.st === TextStyle.Indent) {
        return {
          start: overlapStart - start,
          len: overlapEnd - overlapStart,
          st: style.st,
          indentSize: style.indentSize,
        };
      }

      return {
        start: overlapStart - start,
        len: overlapEnd - overlapStart,
        st: style.st,
      };
    })
    .filter((style): style is NonNullable<typeof style> => style !== null);

  return chunkStyles.length > 0 ? chunkStyles : undefined;
}
