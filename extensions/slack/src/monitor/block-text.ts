import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { renderSlackBlockFallbackText } from "../blocks-fallback.js";

type SlackBlocksText = {
  text: string;
  hasRichText: boolean;
  hasNativeData: boolean;
  hasBasicTable?: boolean;
};

type SlackMessageTextSource = {
  text?: string;
  blocks?: unknown[];
  attachments?: Array<{ blocks?: unknown[] }>;
};

type ResolveSlackMessageTextOptions = {
  preserveMessageTextWhitespace?: boolean;
};

function readSlackBlockType(block: unknown): unknown {
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as { type?: unknown }).type
    : undefined;
}

function isSlackNativeDataBlockType(blockType: unknown): boolean {
  return blockType === "data_visualization" || blockType === "data_table" || blockType === "table";
}

export function hasSlackTableBlock(blocks: unknown[] | undefined): boolean {
  return blocks?.some((block) => readSlackBlockType(block) === "table") ?? false;
}

export function hasSlackMessageTableBlock(message: SlackMessageTextSource): boolean {
  return (
    hasSlackTableBlock(message.blocks) ||
    message.attachments?.some((attachment) => hasSlackTableBlock(attachment.blocks)) === true
  );
}

export function resolveSlackBlocksText(blocks: unknown[] | undefined): SlackBlocksText | undefined {
  if (!blocks?.length) {
    return undefined;
  }
  const parts: string[] = [];
  let hasRichText = false;
  let hasNativeData = false;
  let hasBasicTable = false;
  for (const block of blocks) {
    const blockType = readSlackBlockType(block);
    hasRichText ||= blockType === "rich_text";
    hasNativeData ||= isSlackNativeDataBlockType(blockType);
    const text = renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" });
    if (text) {
      if (blockType === "table") {
        hasBasicTable = true;
      }
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const resolved = { text: parts.join("\n"), hasRichText, hasNativeData };
  return hasBasicTable ? { ...resolved, hasBasicTable: true } : resolved;
}

function chooseSlackPrimaryText(params: {
  messageText: string | undefined;
  blocksText: SlackBlocksText | undefined;
  allowMessagePrefixExpansion?: boolean;
}): string | undefined {
  const { messageText, blocksText } = params;
  if (!blocksText) {
    return messageText;
  }
  if (!messageText) {
    return blocksText.text;
  }
  if (blocksText.hasNativeData) {
    if (!blocksText.hasBasicTable) {
      const comparableMessageText = normalizeLegacyNativeDataText(messageText);
      const comparableBlocksText = normalizeLegacyNativeDataText(blocksText.text);
      if (comparableMessageText.includes(comparableBlocksText)) {
        return messageText;
      }
      return comparableBlocksText.startsWith(comparableMessageText)
        ? blocksText.text
        : `${messageText}\n${blocksText.text}`;
    }
    const comparableMessageText = normalizeComparableNativeDataText(messageText);
    const comparableBlocksText = normalizeComparableNativeDataText(blocksText.text);
    if (containsComparableNativeDataSegment(comparableMessageText, comparableBlocksText)) {
      return messageText;
    }
    return params.allowMessagePrefixExpansion !== false &&
      startsWithComparableText(comparableBlocksText, comparableMessageText)
      ? blocksText.text
      : `${messageText}\n${blocksText.text}`;
  }
  if (blocksText.hasRichText && blocksText.text.length > messageText.length) {
    return blocksText.text;
  }
  return blocksText.text.length > messageText.length && blocksText.text.startsWith(messageText)
    ? blocksText.text
    : messageText;
}

function isComparableWordCharacter(value: string | undefined): boolean {
  return value ? /[\p{L}\p{N}_]/u.test(value) : false;
}

function normalizeLegacyNativeDataText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeComparableNativeDataText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^ *$/u.test(line))
    .map((line) => line.replace(/^ +| +$/gu, ""))
    .join("\n");
}

function containsComparableNativeDataSegment(haystack: string, needle: string): boolean {
  if (!needle) {
    return true;
  }
  return `\n${haystack}\n`.includes(`\n${needle}\n`);
}

function startsWithComparableText(value: string, prefix: string): boolean {
  if (!prefix || !value.startsWith(prefix)) {
    return false;
  }
  const next = value[prefix.length];
  return (
    next === undefined ||
    !isComparableWordCharacter(prefix.at(-1)) ||
    !isComparableWordCharacter(next)
  );
}

function resolveSlackAttachmentTableTexts(
  attachments: SlackMessageTextSource["attachments"],
): SlackBlocksText[] {
  const tableTexts: SlackBlocksText[] = [];
  for (const attachment of attachments ?? []) {
    for (const block of attachment.blocks ?? []) {
      if (readSlackBlockType(block) === "table") {
        const tableText = resolveSlackBlocksText([block]);
        if (tableText) {
          tableTexts.push(tableText);
        }
      }
    }
  }
  return tableTexts;
}

function appendSlackFollowingBlocksText(
  messageText: string | undefined,
  blocksText: SlackBlocksText | undefined,
): string | undefined {
  if (!blocksText) {
    return messageText;
  }
  if (!messageText) {
    return blocksText.text;
  }
  if (blocksText.hasNativeData) {
    return chooseSlackPrimaryText({ messageText, blocksText });
  }
  const comparableMessageText = normalizeComparableNativeDataText(messageText);
  const comparableBlocksText = normalizeComparableNativeDataText(blocksText.text);
  if (containsComparableNativeDataSegment(comparableMessageText, comparableBlocksText)) {
    return messageText;
  }
  return startsWithComparableText(comparableBlocksText, comparableMessageText)
    ? blocksText.text
    : `${messageText}\n${blocksText.text}`;
}

function resolveSlackTopLevelMessageText(
  messageText: string | undefined,
  blocks: unknown[] | undefined,
): string | undefined {
  if (!hasSlackTableBlock(blocks)) {
    return chooseSlackPrimaryText({ messageText, blocksText: resolveSlackBlocksText(blocks) });
  }

  let resolvedText = messageText;
  let pendingBlocks: unknown[] = [];
  let hasRenderedTable = false;
  const flushPendingBlocks = () => {
    const pendingText = resolveSlackBlocksText(pendingBlocks);
    resolvedText = hasRenderedTable
      ? appendSlackFollowingBlocksText(resolvedText, pendingText)
      : chooseSlackPrimaryText({ messageText: resolvedText, blocksText: pendingText });
    pendingBlocks = [];
  };

  for (const block of blocks ?? []) {
    if (readSlackBlockType(block) !== "table") {
      pendingBlocks.push(block);
      continue;
    }
    const tableText = resolveSlackBlocksText([block]);
    if (!tableText) {
      continue;
    }
    flushPendingBlocks();
    resolvedText = chooseSlackPrimaryText({
      messageText: resolvedText,
      blocksText: tableText,
      allowMessagePrefixExpansion: false,
    });
    hasRenderedTable = true;
  }
  flushPendingBlocks();
  return resolvedText;
}

/** Resolve agent-visible message text without admitting ordinary attachment unfurls. */
export function resolveSlackMessageText(
  message: SlackMessageTextSource,
  options: ResolveSlackMessageTextOptions = {},
): string | undefined {
  const messageText = options.preserveMessageTextWhitespace
    ? typeof message.text === "string" && message.text.trim().length > 0
      ? message.text
      : undefined
    : normalizeOptionalString(message.text);
  const primaryText = resolveSlackTopLevelMessageText(messageText, message.blocks);
  return resolveSlackAttachmentTableTexts(message.attachments).reduce<string | undefined>(
    (resolvedText, tableText) =>
      chooseSlackPrimaryText({
        messageText: resolvedText,
        blocksText: tableText,
        allowMessagePrefixExpansion: false,
      }),
    primaryText,
  );
}
