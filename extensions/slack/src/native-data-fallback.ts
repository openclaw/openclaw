import type { Block, KnownBlock } from "@slack/web-api";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { renderSlackBlockFallbackText } from "./blocks-fallback.js";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { SLACK_MESSAGE_TEXT_HARD_LIMIT, SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT } from "./limits.js";
import {
  buildSlackNativeDataAccessibilityText,
  createSlackNativeDataBaseTextConsumer,
  hasSlackNativeDataBlock,
  renderSlackNativeDataPlainTextBlock,
  SLACK_MALFORMED_NATIVE_DATA_FALLBACK,
  stripSlackNativeDataBlocks,
} from "./native-data-blocks.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_SECTION_PLAIN_TEXT_MAX = 3_000;
const SLACK_EMPTY_BLOCK_FALLBACK = "Shared a Block Kit message";

export type SlackFormattingDisabledMessage = {
  text: string;
  blocks?: (Block | KnownBlock)[];
  mrkdwn: false;
};

export function chunkSlackTextAtHardLimit(
  text: string,
  limit = SLACK_MESSAGE_TEXT_HARD_LIMIT,
): string[] {
  if (!text) {
    return [];
  }
  const effectiveLimit = Math.max(1, Math.floor(limit));
  return chunkTextForOutbound(text, effectiveLimit, { preserveWhitespace: true });
}

function buildOrderedBlockMessages(params: {
  baseText: string;
  blocks: readonly (Block | KnownBlock)[];
  textLimit: number;
}): SlackFormattingDisabledMessage[] {
  const messages: SlackFormattingDisabledMessage[] = [];
  let blocks: (Block | KnownBlock)[] = [];
  let text = "";

  const flush = () => {
    if (blocks.length === 0) {
      return;
    }
    messages.push({
      text: text || SLACK_EMPTY_BLOCK_FALLBACK,
      blocks,
      mrkdwn: false,
    });
    blocks = [];
    text = "";
  };
  const append = (block: Block | KnownBlock, entryText = "", continuesText = false) => {
    const separator = text && entryText && !continuesText ? "\n\n" : "";
    let nextText = entryText ? `${text}${separator}${entryText}` : text;
    if (blocks.length >= SLACK_MAX_BLOCKS || nextText.length > params.textLimit) {
      flush();
      nextText = entryText;
    }
    // Native controls are indivisible. Their derived summary has a hard limit;
    // authored fallback sections are split before they enter this batch.
    blocks.push(block);
    text = nextText;
  };
  const appendPlainText = (value: string) => {
    const chunks = chunkSlackTextAtHardLimit(
      value,
      Math.min(params.textLimit, SLACK_SECTION_PLAIN_TEXT_MAX),
    );
    chunks.forEach((chunk, index) => {
      append({ type: "section", text: { type: "plain_text", text: chunk } }, chunk, index > 0);
    });
  };

  const consumeFromBase = createSlackNativeDataBaseTextConsumer(params.baseText);
  appendPlainText(params.baseText);
  for (const block of params.blocks) {
    if (hasSlackNativeDataBlock([block])) {
      const nativeText =
        renderSlackNativeDataPlainTextBlock(block)?.trim() || SLACK_MALFORMED_NATIVE_DATA_FALLBACK;
      if (!consumeFromBase(nativeText)) {
        appendPlainText(nativeText);
      }
      continue;
    }
    append(
      block,
      truncateSlackText(
        renderSlackBlockFallbackText(block, {
          nativeDataFormat: "plain",
          includeSelectOptions: true,
        }) ?? "",
        SLACK_MESSAGE_TEXT_HARD_LIMIT,
      ),
    );
  }
  flush();
  return messages;
}

/** Build one complete, ordered retry plan after Slack rejects native data blocks. */
export function buildSlackNativeDataDeliveryPlan(params: {
  baseText?: string;
  blocks: readonly (Block | KnownBlock)[];
  textLimit?: number;
}) {
  const baseText = params.baseText?.trim() ?? "";
  const textLimit = Math.min(
    SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT,
    SLACK_MESSAGE_TEXT_HARD_LIMIT,
    Math.max(1, Math.floor(params.textLimit ?? SLACK_MESSAGE_TEXT_HARD_LIMIT)),
  );
  const hasNativeData = hasSlackNativeDataBlock(params.blocks);
  const accessibilityText =
    buildSlackNativeDataAccessibilityText(baseText, params.blocks) ||
    (hasNativeData ? SLACK_MALFORMED_NATIVE_DATA_FALLBACK : SLACK_EMPTY_BLOCK_FALLBACK);
  const survivorBlocks = stripSlackNativeDataBlocks(params.blocks);
  const fallbackMessages: SlackFormattingDisabledMessage[] =
    survivorBlocks.length === 0
      ? chunkSlackTextAtHardLimit(accessibilityText, textLimit).map((text) => ({
          text,
          mrkdwn: false as const,
        }))
      : buildOrderedBlockMessages({ baseText, blocks: params.blocks, textLimit });
  return {
    accessibilityText: truncateSlackText(accessibilityText, SLACK_MESSAGE_TEXT_HARD_LIMIT),
    fallbackMessages,
    skipOriginalBlocks: accessibilityText.length > SLACK_MESSAGE_TEXT_HARD_LIMIT,
  };
}
