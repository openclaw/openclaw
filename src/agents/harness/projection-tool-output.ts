import { formatToolAggregate } from "../../auto-reply/tool-meta.js";
import { redactToolDetail } from "../../logging/redact.js";
import { formatFencedCodeBlock } from "../../shared/markdown-code.js";
import { truncateUtf16Safe } from "../../utils.js";

export const TOOL_PROGRESS_OUTPUT_MAX_CHARS = 8_000;

export const MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM = 20;
export const TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS = 10_000;

export class NativeToolOutputAccumulator {
  constructor(private readonly nativeToolLabel: string) {}

  private readonly items = new Map<string, ToolOutputState>();
  readonly textByItem = new Map<string, string>();

  isTruncated(itemId: string): boolean {
    return (this.items.get(itemId)?.originalLength ?? 0) > TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS;
  }

  append(
    itemId: string,
    delta: string,
  ): { text: string; originalLength: number; normalizedLength: number; rawPrefix: string } {
    const state = this.items.get(itemId) ?? {
      rawPrefix: this.textByItem.get(itemId) ?? "",
      originalLength: this.textByItem.get(itemId)?.length ?? 0,
      normalizedLength: 0,
      trailingWhitespaceLength: 0,
    };
    const truncated = this.isTruncated(itemId);
    const originalLength = (state.originalLength += delta.length);
    const normalizedLength = updateToolOutputTrimState(state, delta);
    // Lengths keep growing after truncation for echo matching + the notice total;
    // the stored raw prefix freezes so later deltas cannot fill UTF-16 capacity
    // recovered by backing up over a split surrogate pair.
    const next = appendBoundedToolTranscriptText(
      state.rawPrefix,
      truncated ? "" : delta,
      originalLength,
      this.nativeToolLabel,
    );
    state.rawPrefix = next.rawPrefix;
    this.items.set(itemId, state);
    this.textByItem.set(itemId, next.text);
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
  return `${formatNativeToolSummary(toolName, meta)}\n${formatFencedCodeBlock(formattedOutput, "txt")}`;
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

type ToolOutputState = {
  rawPrefix: string;
  originalLength: number;
  normalizedLength: number;
  trailingWhitespaceLength: number;
};

function updateToolOutputTrimState(state: ToolOutputState, delta: string): number {
  const firstNonWhitespace = delta.search(/\S/u);
  if (firstNonWhitespace === -1) {
    state.trailingWhitespaceLength += delta.length;
  } else {
    const trimmedLength = delta.trimEnd().length;
    state.normalizedLength +=
      (state.normalizedLength > 0 ? state.trailingWhitespaceLength : -firstNonWhitespace) +
      trimmedLength;
    state.trailingWhitespaceLength = delta.length - trimmedLength;
  }
  return state.normalizedLength;
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
