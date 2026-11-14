import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PluginTextReplacement } from "../plugins/cli-backend.types.js";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import type { CliCommentarySegment, CliOutput } from "./cli-output-contracts.js";
import { partitionLeadingTaggedReasoning } from "./cli-output-events.js";
import {
  isClaudeSyntheticNoResponse,
  preferStreamedClaudeTextOverResult,
} from "./cli-output-records.js";
import { applyPluginTextReplacements } from "./plugin-text-transforms.js";

export function transformCliResultText(
  output: CliOutput,
  replacements?: PluginTextReplacement[],
): CliOutput {
  return {
    ...output,
    rawText: output.text,
    text: applyPluginTextReplacements(output.text, replacements),
    ...(output.textParts
      ? {
          textParts: output.textParts.map((text) =>
            applyPluginTextReplacements(text, replacements),
          ),
        }
      : {}),
  };
}

/** Records the model's final message when it differs from the cumulative delivery text. */
export function withCliRawFinalText(output: CliOutput, finalMessageText: string): CliOutput {
  if (finalMessageText !== output.text.trim()) {
    return { ...output, rawFinalText: finalMessageText };
  }
  // A replacement result spreads the earlier output; drop its stale final message.
  const { rawFinalText: _staleFinalText, ...current } = output;
  return current;
}

/** Keep completed answers distinct while retaining cumulative transcript text. */
export function appendCliResultText(previous: CliOutput | null, nextText: string) {
  const previousText = previous?.text.trim() ?? "";
  // Each result commits its own answer. Only assistant snapshots are cumulative;
  // a shared prefix cannot distinguish a new answer ("Hi" -> "History") from one.
  const previousParts = previous?.textParts ?? (previousText ? [previousText] : []);
  const completedText = nextText === previousParts.at(-1) ? "" : nextText;
  const text = completedText
    ? previousText
      ? `${previousText}\n${completedText}`
      : completedText
    : previousText;
  const textParts = completedText ? [...previousParts, completedText] : previousParts;
  return { text, textParts, completedText };
}

/**
 * Stores a record's message item text and returns the text that is still the
 * final message: a later tool item ends it, like a tool_use block does.
 */
export function recordItemText(
  parsed: Record<string, unknown>,
  texts: string[],
  finalItemText: string | undefined,
): string | undefined {
  const item = isRecord(parsed.item) ? parsed.item : null;
  if (!item) {
    return finalItemText;
  }
  const type = normalizeLowercaseStringOrEmpty(item.type);
  if (!type || type.includes("message")) {
    if (typeof item.text !== "string") {
      return finalItemText;
    }
    texts.push(item.text);
    return item.text;
  }
  return type.includes("reasoning") ? finalItemText : undefined;
}

type CliSnapshotTextSpan = { text: string; key?: string };

/** Track emitted text by its native snapshot, independently of commentary routing. */
export function createCliSnapshotTextTracker() {
  const assistant: CliSnapshotTextSpan[] = [];
  let pending: CliSnapshotTextSpan[] = [];
  let buffered: CliSnapshotTextSpan[] = [];
  const record = (text: string) => {
    const span: CliSnapshotTextSpan = { text };
    pending.push(span);
    return span;
  };
  return {
    append(text: string) {
      assistant.push(record(text));
    },
    buffer(text: string) {
      buffered.push(record(text));
    },
    flush(visible: boolean) {
      if (visible) {
        assistant.push(...buffered);
      }
      buffered = [];
    },
    beginMessage() {
      pending = [];
    },
    snapshot(key: string | undefined) {
      if (!key) {
        return;
      }
      for (const span of pending) {
        span.key = key;
      }
      pending = [];
    },
    output<T extends (CliOutput & { partialOutputRejected?: true }) | null>(
      resolved: T,
      text: string,
      enabled: boolean,
    ) {
      const ranges = enabled && !resolved?.partialOutputRejected ? this.ranges(text, 0) : [];
      return resolved && ranges.length ? { ...resolved, textSnapshotRanges: ranges } : resolved;
    },
    ranges(text: string, from: number): NonNullable<CliOutput["textSnapshotRanges"]> {
      const slice = text.slice(from);
      const start = from + slice.length - slice.trimStart().length;
      const end = start + slice.trim().length;
      const ranges: NonNullable<CliOutput["textSnapshotRanges"]> = [];
      let offset = 0;
      for (const span of assistant) {
        const left = Math.max(start, offset);
        offset += span.text.length;
        const right = Math.min(end, offset);
        if (span.key && right > left) {
          const previous = ranges.at(-1);
          if (previous?.key === span.key && previous.end === left - start) {
            previous.end = right - start;
          } else {
            ranges.push({ key: span.key, start: left - start, end: right - start });
          }
        }
      }
      return ranges;
    },
  };
}

export function appendCliSnapshotRanges(
  previous: CliOutput | null,
  ranges: NonNullable<CliOutput["textSnapshotRanges"]>,
  completedText: string,
): NonNullable<CliOutput["textSnapshotRanges"]> {
  const previousLength = previous?.text.trim().length ?? 0;
  const offset = previousLength ? previousLength + 1 : 0;
  return [
    ...(previous?.textSnapshotRanges ?? []),
    ...(completedText
      ? ranges.map((range) => ({
          key: range.key,
          start: range.start + offset,
          end: range.end + offset,
        }))
      : []),
  ];
}

/** A completed native block, not a streaming delta or a child/synthetic record. */
export function readClaudeSnapshotSegment(
  parsed: Record<string, unknown>,
  sessionId: string | undefined,
): CliCommentarySegment | undefined {
  if (
    !sessionId ||
    typeof parsed.uuid !== "string" ||
    !isRecord(parsed.message) ||
    !Array.isArray(parsed.message.content) ||
    isClaudeSyntheticNoResponse(parsed)
  ) {
    return undefined;
  }
  const text = parsed.message.content
    .flatMap((block: unknown) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n\n");
  const partition = partitionLeadingTaggedReasoning(text, true);
  if (partition.pending || !partition.visibleText.trim()) {
    return undefined;
  }
  return {
    key: `${sessionId}:${parsed.uuid}`,
    text: partition.visibleText,
    timestamp: Date.now(),
    native: { entryId: parsed.uuid, sessionId },
  };
}

/** Select output text and its snapshot provenance together, including interim results. */
export function appendClaudeStreamResult(params: {
  previous: CliOutput | null;
  resultText: string;
  assistantText: string;
  texts: string[];
  offsets: { segmentStart: number; preserveFrom: number; currentMessageStart: number };
  sessionId?: string;
  resumeCheckpointId?: string;
  snapshotText: ReturnType<typeof createCliSnapshotTextTracker>;
}) {
  const {
    previous,
    resultText,
    assistantText,
    texts,
    offsets,
    sessionId,
    resumeCheckpointId,
    snapshotText,
  } = params;
  const streamedText = assistantText.slice(offsets.segmentStart).trim();
  const preservedCandidate = assistantText.slice(offsets.preserveFrom).trim();
  const keepStreamed = preferStreamedClaudeTextOverResult({
    streamedText: preservedCandidate,
    finalMessageText: assistantText.slice(offsets.currentMessageStart).trim(),
    resultText,
  });
  const nextText = (
    keepStreamed ? preservedCandidate : resultText || streamedText || texts.join("\n").trim()
  ).trim();
  const appended = appendCliResultText(previous, nextText);
  const nextRanges = keepStreamed
    ? snapshotText.ranges(assistantText, offsets.preserveFrom)
    : !resultText && streamedText
      ? snapshotText.ranges(assistantText, offsets.segmentStart)
      : resultText && sessionId && resumeCheckpointId
        ? [{ key: `${sessionId}:${resumeCheckpointId}`, start: 0, end: nextText.length }]
        : [];
  return {
    ...appended,
    nextText,
    textSnapshotRanges: appendCliSnapshotRanges(previous, nextRanges, appended.completedText),
  };
}

/** Share the interrupted-output verdict with snapshots before they reach persistence. */
export function hasInterruptedClaudeToolProtocol(text: string): boolean {
  const codeRegions = findCodeRegions(text);
  return [...text.matchAll(/(?:^|\n)[ \t]*<(?:invoke|parameter)(?=[\s/>]|$)/gu)].some(
    (match) => !isInsideCode(match.index + match[0].lastIndexOf("<"), codeRegions),
  );
}

/** Hold revisions until the next native block, then use the ordinary prepared-write path. */
export function createClaudeSnapshotSegmentBuffer(emit?: (segment: CliCommentarySegment) => void) {
  let key: string | undefined;
  let pending: CliCommentarySegment | undefined;
  let completed = false;
  const flush = (interrupted = true) => {
    const segment = pending;
    pending = undefined;
    if (segment && (!interrupted || completed || !hasInterruptedClaudeToolProtocol(segment.text))) {
      emit?.(segment);
    }
  };
  return {
    flush,
    observe(parsed: Record<string, unknown>, sessionId: string | undefined) {
      const nextKey =
        sessionId && typeof parsed.uuid === "string" ? `${sessionId}:${parsed.uuid}` : undefined;
      if (nextKey && nextKey !== key) {
        flush();
        key = nextKey;
      }
      const segment = readClaudeSnapshotSegment(parsed, sessionId);
      if (segment) {
        pending = segment;
        completed = isRecord(parsed.message) && typeof parsed.message.stop_reason === "string";
      }
      return segment;
    },
  };
}
