import { formatToolAggregate } from "../../auto-reply/tool-meta.js";
import { redactToolDetail } from "../../logging/redact.js";
import { truncateUtf16Safe } from "../../utils.js";

export const TOOL_PROGRESS_OUTPUT_MAX_CHARS = 8_000;

export const MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM = 20;
export const TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS = 10_000;

export class NativeToolOutputAccumulator {
  constructor(private readonly nativeToolLabel: string) {}

  private readonly prefixByItem = new Map<string, string>();
  private readonly originalLengthByItem = new Map<string, number>();
  private readonly trimStateByItem = new Map<string, ToolOutputTrimState>();
  private readonly truncatedItemIds = new Set<string>();
  readonly textByItem = new Map<string, string>();

  isTruncated(itemId: string): boolean {
    return this.truncatedItemIds.has(itemId);
  }

  append(
    itemId: string,
    delta: string,
  ): { text: string; originalLength: number; normalizedLength: number; rawPrefix: string } {
    const previousOriginalLength =
      this.originalLengthByItem.get(itemId) ?? this.textByItem.get(itemId)?.length ?? 0;
    const originalLength = previousOriginalLength + delta.length;
    this.originalLengthByItem.set(itemId, originalLength);
    const normalizedLength = updateToolOutputTrimState(this.trimStateByItem, itemId, delta);
    // Lengths keep growing after truncation for echo matching + the notice total;
    // the stored raw prefix freezes so later deltas cannot fill UTF-16 capacity
    // recovered by backing up over a split surrogate pair.
    const currentPrefix = this.prefixByItem.get(itemId) ?? this.textByItem.get(itemId) ?? "";
    const next = appendBoundedToolTranscriptText(
      currentPrefix,
      this.truncatedItemIds.has(itemId) ? "" : delta,
      originalLength,
      this.nativeToolLabel,
    );
    this.prefixByItem.set(itemId, next.rawPrefix);
    this.textByItem.set(itemId, next.text);
    if (originalLength > TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
      this.truncatedItemIds.add(itemId);
    }
    return { text: next.text, originalLength, normalizedLength, rawPrefix: next.rawPrefix };
  }
}

export function truncateNativeToolTranscriptText(
  text: string,
  nativeToolLabel: string,
  originalLength = text.length,
): string {
  if (
    originalLength <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS &&
    text.length <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS
  ) {
    return text;
  }
  const notice = toolTranscriptTruncationNotice(originalLength, nativeToolLabel);
  if (notice.length >= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    return notice.slice(1, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS + 1);
  }
  const textBudget = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - notice.length;
  return `${truncateUtf16Safe(text, textBudget)}${notice}`;
}

export function formatNativeToolSummary(toolName: string, meta?: string): string {
  const trimmedMeta = meta?.trim();
  return formatToolAggregate(toolName, trimmedMeta ? [trimmedMeta] : undefined, {
    markdown: true,
  });
}

export function formatNativeToolOutput(
  toolName: string,
  meta: string | undefined,
  output: string,
): string {
  const formattedOutput = formatToolProgressOutput(output);
  if (!formattedOutput) {
    return formatNativeToolSummary(toolName, meta);
  }
  const fence = markdownFenceForText(formattedOutput);
  return `${formatNativeToolSummary(toolName, meta)}\n${fence}txt\n${formattedOutput}\n${fence}`;
}

/**
 * Prepare verbose tool output for user-facing progress messages.
 */
export function formatToolProgressOutput(
  output: string,
  options?: { maxChars?: number },
): string | undefined {
  const trimmed = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!trimmed) {
    return undefined;
  }
  const redacted = redactToolDetail(trimmed);
  const maxChars = options?.maxChars ?? TOOL_PROGRESS_OUTPUT_MAX_CHARS;
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${truncateUtf16Safe(redacted, maxChars)}\n...(truncated)...`;
}

type ToolOutputTrimState = {
  totalLength: number;
  leadingWhitespaceLength: number;
  trailingWhitespaceLength: number;
  sawNonWhitespace: boolean;
};

function updateToolOutputTrimState(
  trimStateByItem: Map<string, ToolOutputTrimState>,
  itemId: string,
  delta: string,
): number {
  const state = trimStateByItem.get(itemId) ?? {
    totalLength: 0,
    leadingWhitespaceLength: 0,
    trailingWhitespaceLength: 0,
    sawNonWhitespace: false,
  };
  state.totalLength += delta.length;
  const firstNonWhitespace = delta.search(/\S/u);
  if (firstNonWhitespace === -1) {
    if (!state.sawNonWhitespace) {
      state.leadingWhitespaceLength += delta.length;
    }
    state.trailingWhitespaceLength += delta.length;
    trimStateByItem.set(itemId, state);
    return state.sawNonWhitespace
      ? state.totalLength - state.leadingWhitespaceLength - state.trailingWhitespaceLength
      : 0;
  }
  if (!state.sawNonWhitespace) {
    state.leadingWhitespaceLength += firstNonWhitespace;
    state.sawNonWhitespace = true;
  }
  state.trailingWhitespaceLength = delta.match(/\s*$/u)?.[0].length ?? 0;
  trimStateByItem.set(itemId, state);
  return state.totalLength - state.leadingWhitespaceLength - state.trailingWhitespaceLength;
}

function appendBoundedToolTranscriptText(
  currentPrefix: string,
  delta: string,
  originalLength: number,
  nativeToolLabel: string,
): { text: string; rawPrefix: string } {
  if (originalLength <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    const rawPrefix = currentPrefix + delta;
    return { text: rawPrefix, rawPrefix };
  }
  const notice = toolTranscriptTruncationNotice(originalLength, nativeToolLabel);
  if (notice.length >= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    return { text: notice.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS), rawPrefix: "" };
  }
  const textBudget = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - notice.length;
  const remaining = Math.max(0, textBudget - currentPrefix.length);
  const prefix =
    remaining > 0 ? `${currentPrefix}${truncateUtf16Safe(delta, remaining)}` : currentPrefix;
  const rawPrefix = truncateUtf16Safe(prefix, textBudget);
  return { text: `${rawPrefix}${notice}`, rawPrefix };
}

function toolTranscriptTruncationNotice(originalLength: number, nativeToolLabel: string): string {
  const noticeText = `...(OpenClaw truncated ${nativeToolLabel} native tool output: original ${originalLength} chars, showing ${TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS}; rerun with narrower args.)`;
  return `\n${noticeText}`;
}

function markdownFenceForText(text: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }
  return longest;
}
