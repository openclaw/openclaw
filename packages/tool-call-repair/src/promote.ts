import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isOffsetInProtectedRanges,
  type PlainTextToolCallProtectedRangeResolver,
} from "./contracts.js";
import { parseStandalonePlainTextToolCallBlocks, type PlainTextToolCallBlock } from "./payload.js";

/** Resolves model-emitted tool names to the exact names allowed by the provider request. */
export type ToolCallRepairNameResolver = (
  rawName: string,
  allowedToolNames: Set<string>,
) => string | null;

/** Builds a provider-native tool-call block from a repaired plain-text payload. */
export type PromotedPlainTextToolCallBlockFactory = (
  block: PlainTextToolCallBlock,
  resolvedName: string,
) => Record<string, unknown>;

/** Controls when standalone assistant text may be rewritten as tool-call content. */
export type PlainTextToolCallPromotionOptions = {
  allowedStopReasons?: ReadonlySet<unknown>;
  allowedToolNames: Set<string>;
  createToolCallBlock: PromotedPlainTextToolCallBlockFactory;
  isRetainableNonTextBlock?: (block: Record<string, unknown>) => boolean;
  message: unknown;
  requireAssistantRole?: boolean;
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver;
  resolveToolName?: ToolCallRepairNameResolver;
};

export type PlainTextToolCallMessageProjection = {
  message: Record<string, unknown>;
  sourceToProjectedContentIndex: ReadonlyMap<number, number>;
};

/** Builds the shared assistant-message shape for a repaired text tool call. */
export function createPromotedPlainTextToolCallBlock(
  block: PlainTextToolCallBlock,
  name: string,
): Record<string, unknown> {
  return {
    type: "toolCall",
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    name,
    arguments: block.arguments,
  };
}

/** Emits the complete provider-neutral lifecycle for promoted tool-call blocks. */
export function createPromotedPlainTextToolCallEvents(
  message: Record<string, unknown>,
): Record<string, unknown>[] {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block, contentIndex) => {
    const toolCall = asRecord(block);
    if (toolCall?.type !== "toolCall") {
      return [];
    }
    const partialJson = JSON.stringify(toolCall.arguments ?? {});
    const streamingCall = { ...toolCall, partialJson };
    return [
      { type: "toolcall_start", contentIndex, partial: message },
      {
        type: "toolcall_delta",
        contentIndex,
        delta: partialJson,
        partial: {
          ...message,
          content: content.map((item, index) => (index === contentIndex ? streamingCall : item)),
        },
      },
      { type: "toolcall_end", contentIndex, toolCall, partial: message },
    ];
  });
}

function resolveExactToolName(rawName: string, allowedToolNames: Set<string>): string | null {
  return allowedToolNames.has(rawName) ? rawName : null;
}

function createPromotedToolCallBlocks(
  text: string,
  options: PlainTextToolCallPromotionOptions,
  lineBreakOffsets?: ReadonlySet<number>,
): Record<string, unknown>[] | undefined {
  const parsedBlocks = parseStandalonePlainTextToolCallBlocks(
    text,
    undefined,
    lineBreakOffsets ? { lineBreakOffsets } : undefined,
  );
  if (!parsedBlocks) {
    return undefined;
  }
  const protectedRanges = options.resolveProtectedRanges?.(text) ?? [];
  if (parsedBlocks.some((block) => isOffsetInProtectedRanges(block.start, protectedRanges))) {
    return undefined;
  }

  const resolveToolName = options.resolveToolName ?? resolveExactToolName;
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of parsedBlocks) {
    const resolvedName = resolveToolName(block.name, options.allowedToolNames);
    if (!resolvedName) {
      return undefined;
    }
    toolCalls.push(options.createToolCallBlock(block, resolvedName));
  }
  return toolCalls;
}

/** Promotes text calls and maps source blocks retained in the projected message. */
export function projectStandalonePlainTextToolCallMessage(
  options: PlainTextToolCallPromotionOptions,
): PlainTextToolCallMessageProjection | undefined {
  const messageRecord = asRecord(options.message);
  if (
    !messageRecord ||
    options.allowedToolNames.size === 0 ||
    (options.requireAssistantRole && messageRecord.role !== "assistant") ||
    (options.allowedStopReasons && !options.allowedStopReasons.has(messageRecord.stopReason))
  ) {
    return undefined;
  }

  const originalContent = messageRecord.content;
  if (typeof originalContent === "string") {
    const toolCalls = createPromotedToolCallBlocks(originalContent, options);
    if (!toolCalls) {
      return undefined;
    }
    return {
      message: {
        ...messageRecord,
        content: toolCalls,
        stopReason: "toolUse",
      },
      sourceToProjectedContentIndex: new Map(),
    };
  }

  if (!Array.isArray(originalContent)) {
    return undefined;
  }

  const content: Array<Record<string, unknown>> = [];
  const sourceToProjectedContentIndex = new Map<number, number>();
  let promotedTextBlock = false;
  let textParts: string[] = [];
  const flushTextParts = (): boolean => {
    const text = textParts.join("");
    let offset = 0;
    const lineBreakOffsets = new Set(
      textParts.slice(0, -1).map((part) => {
        offset += part.length;
        return offset;
      }),
    );
    lineBreakOffsets.delete(text.length);
    const toolCalls = text.trim()
      ? createPromotedToolCallBlocks(text, options, lineBreakOffsets)
      : [];
    textParts = [];
    if (!toolCalls) {
      return false;
    }
    content.push(...toolCalls);
    promotedTextBlock ||= toolCalls.length > 0;
    return true;
  };

  for (const [sourceIndex, block] of originalContent.entries()) {
    const blockRecord = asRecord(block);
    if (!blockRecord) {
      return undefined;
    }
    if (blockRecord.type === "text") {
      if (typeof blockRecord.text !== "string") {
        return undefined;
      }
      textParts.push(blockRecord.text);
      continue;
    }
    if (!flushTextParts()) {
      return undefined;
    }
    if (options.isRetainableNonTextBlock?.(blockRecord)) {
      sourceToProjectedContentIndex.set(sourceIndex, content.length);
      content.push(blockRecord);
      continue;
    }
    return undefined;
  }

  if (!flushTextParts() || !promotedTextBlock) {
    return undefined;
  }

  return {
    message: {
      ...messageRecord,
      content,
      stopReason: "toolUse",
    },
    sourceToProjectedContentIndex,
  };
}
