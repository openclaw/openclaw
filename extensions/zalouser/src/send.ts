import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelMessageSendResult } from "openclaw/plugin-sdk/channel-outbound";
import { chunkTextRanges } from "openclaw/plugin-sdk/text-chunking";
import { sliceTextStyles } from "./text-styles-ranges.js";
import { parseZalouserTextStyles } from "./text-styles.js";
import type { ZaloSendOptions } from "./types.js";
import { sendZaloTextMessage } from "./zalo-js.js";

type ZalouserSendOptions = ZaloSendOptions & {
  /** Persist each concrete platform send before the next internal chunk starts. */
  onDeliveryResult?: (result: ChannelMessageSendResult) => Promise<void> | void;
};

const ZALO_TEXT_LIMIT = 2000;

export async function sendMessageZalouser(
  threadId: string,
  text: string,
  options: ZalouserSendOptions = {},
): Promise<ChannelMessageSendResult> {
  const { onDeliveryResult, ...transportOptions } = options;
  const prepared =
    transportOptions.textMode === "markdown"
      ? parseZalouserTextStyles(text)
      : { text, styles: transportOptions.textStyles };
  const textChunkLimit = transportOptions.textChunkLimit ?? ZALO_TEXT_LIMIT;
  const chunkText = prepared.text;
  const styles = (prepared.styles?.length ?? 0) > 0 ? prepared.styles : undefined;
  const mode = transportOptions.textChunkMode;
  const chunks =
    chunkText.length === 0
      ? [{ text: chunkText, styles: undefined }]
      : chunkTextRanges(chunkText, {
          limit: textChunkLimit,
          mode: mode === "newline" ? "preferred" : "hard",
        }).map(({ start, end }) => ({
          text: chunkText.slice(start, end),
          styles: sliceTextStyles(styles, start, end),
        }));

  let lastResult: ChannelMessageSendResult | null = null;
  const accepted: ChannelMessageSendResult[] = [];
  try {
    for (const [index, chunk] of chunks.entries()) {
      const chunkOptions =
        index === 0
          ? { ...transportOptions, textStyles: chunk.styles }
          : {
              ...transportOptions,
              caption: undefined,
              mediaLocalRoots: undefined,
              mediaUrl: undefined,
              textStyles: chunk.styles,
            };
      const chunkStart = accepted.length;
      const result = await sendZaloTextMessage(
        threadId,
        chunk.text,
        chunkOptions,
        async (progress) => {
          accepted.push(progress);
          await onDeliveryResult?.(progress);
        },
      );
      // The final chunk receipt includes any nested audio progress already reported.
      accepted.splice(chunkStart, accepted.length - chunkStart, result);
      await onDeliveryResult?.(result);
      lastResult = result;
    }
  } catch (error) {
    if (accepted.length > 0) {
      throw createChannelPartialDeliveryError(
        error,
        createAcceptedChannelDeliveryResult({ results: accepted }),
      );
    }
    throw error;
  }

  if (!lastResult) {
    throw new Error("No message content provided");
  }
  return lastResult;
}

export async function sendImageZalouser(
  threadId: string,
  imageUrl: string,
  options: ZalouserSendOptions = {},
): Promise<ChannelMessageSendResult> {
  return await sendMessageZalouser(threadId, options.caption ?? "", {
    ...options,
    caption: undefined,
    mediaUrl: imageUrl,
  });
}
