import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PluginTextReplacement } from "../plugins/cli-backend.types.js";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import type { CliCommentarySegment, CliOutput } from "./cli-output-contracts.js";
import { partitionLeadingTaggedReasoning } from "./cli-output-events.js";
import { preferStreamedClaudeTextOverResult } from "./cli-output-records.js";
import { applyPluginTextReplacements } from "./plugin-text-transforms.js";

export function transformCliResultText(
  output: CliOutput,
  replacements?: PluginTextReplacement[],
): CliOutput {
  return {
    ...output,
    rawText: output.text,
    ...(output.interimNativeReplies
      ? {
          interimNativeReplies: output.interimNativeReplies.map((reply) => ({
            ...reply,
            text: applyPluginTextReplacements(reply.text, replacements),
          })),
        }
      : {}),
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
function appendCliResultText(previous: CliOutput | null, nextText: string, distinct = false) {
  const previousText = previous?.text.trim() ?? "";
  // Each result commits its own answer. Only assistant snapshots are cumulative;
  // a shared prefix cannot distinguish a new answer ("Hi" -> "History") from one.
  const previousParts = previous?.textParts ?? (previousText ? [previousText] : []);
  const completedText = !distinct && nextText === previousParts.at(-1) ? "" : nextText;
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

type CliSnapshotTextOwner = { key?: string; id?: string };
type CliSnapshotTextSpan = { text: string; owner: CliSnapshotTextOwner };

/** Track emitted text by its native snapshot, independently of commentary routing. */
export function createCliSnapshotTextTracker(trackOccurrences = false) {
  const assistant: CliSnapshotTextSpan[] = [];
  let buffered: CliSnapshotTextSpan[] = [];
  // A partial frame's UUID is not the later assistant record's UUID. Keep its
  // live bytes together until the parser sees the snapshot that owns them.
  let owner: CliSnapshotTextOwner = {};
  const record = (spans: CliSnapshotTextSpan[], text: string) => {
    if (trackOccurrences) {
      owner.id ??= randomUUID();
    }
    const last = spans.at(-1);
    if (last?.owner === owner) {
      last.text += text;
    } else {
      spans.push({ text, owner });
    }
    return owner.id;
  };
  return {
    append(text: string) {
      return record(assistant, text);
    },
    buffer(text: string) {
      record(buffered, text);
    },
    flush(visible: boolean) {
      const spans = buffered;
      if (visible) {
        assistant.push(...spans);
      }
      buffered = [];
      return spans;
    },
    beginMessage() {
      owner = {};
    },
    snapshot(key: string) {
      owner.key = key;
      const id = owner.id;
      owner = {};
      return id;
    },
    output<T extends (CliOutput & { partialOutputRejected?: true }) | null>(
      resolved: T,
      text: string,
      enabled: boolean,
      from = 0,
      previous: CliOutput | null = null,
    ) {
      if (!resolved || resolved.partialOutputRejected || !enabled) {
        return resolved;
      }
      const source = this.provenance(text, from);
      if (!previous) {
        return {
          ...resolved,
          ...(source.ranges.length ? { textSnapshotRanges: source.ranges } : {}),
          ...(source.occurrences.length ? { assistantOccurrences: source.occurrences } : {}),
        };
      }
      const appended = appendCliResultText(previous, resolved.text, true);
      const ranges = appendCliSnapshotRanges(previous, source.ranges, appended.completedText);
      const occurrences = [...(previous.assistantOccurrences ?? []), ...source.occurrences];
      return withCliRawFinalText(
        {
          ...previous,
          ...resolved,
          text: appended.text,
          textParts: appended.textParts,
          ...(ranges.length ? { textSnapshotRanges: ranges } : {}),
          ...(occurrences.length ? { assistantOccurrences: occurrences } : {}),
        },
        resolved.rawFinalText ?? resolved.text,
      );
    },
    provenance(text: string, from: number) {
      const slice = text.slice(from);
      const start = from + slice.length - slice.trimStart().length;
      const end = start + slice.trim().length;
      const ranges: NonNullable<CliOutput["textSnapshotRanges"]> = [];
      const occurrences: NonNullable<CliOutput["assistantOccurrences"]> = [];
      let offset = 0;
      for (const span of assistant) {
        const left = Math.max(start, offset);
        offset += span.text.length;
        const right = Math.min(end, offset);
        if (right <= left) {
          continue;
        }
        const { key, id } = span.owner;
        if (id && id !== occurrences.at(-1)?.id) {
          occurrences.push({ id, key });
        }
        if (key) {
          const previous = ranges.at(-1);
          if (previous?.key === key && previous.end === left - start) {
            previous.end = right - start;
          } else {
            ranges.push({ key, start: left - start, end: right - start });
          }
        }
      }
      return { ranges, occurrences };
    },
  };
}

function appendCliSnapshotRanges(
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
function readClaudeSnapshotSegment(
  parsed: Record<string, unknown>,
  sessionId: string | undefined,
): CliCommentarySegment | undefined {
  if (
    !sessionId ||
    typeof parsed.uuid !== "string" ||
    !isRecord(parsed.message) ||
    !Array.isArray(parsed.message.content)
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
    ...(typeof parsed.message.id === "string" ? { itemId: parsed.message.id } : {}),
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
  const distinctNativeReply = Boolean(
    previous?.resumeCheckpointId &&
    resumeCheckpointId &&
    (previous.resumeCheckpointId !== resumeCheckpointId || previous.sessionId !== sessionId),
  );
  const appended = appendCliResultText(previous, nextText, distinctNativeReply);
  // Choose live occurrences from the same message/segment as the saved result,
  // never from an earlier draft merely because it is not already in history.
  const streamed = keepStreamed || (!resultText && Boolean(streamedText));
  const source = snapshotText.provenance(
    assistantText,
    keepStreamed
      ? offsets.preserveFrom
      : streamed
        ? offsets.segmentStart
        : offsets.currentMessageStart,
  );
  const finalKey =
    resultText && sessionId && resumeCheckpointId
      ? `${sessionId}:${resumeCheckpointId}`
      : undefined;
  const nextRanges = streamed
    ? source.ranges
    : finalKey
      ? [{ key: finalKey, start: 0, end: nextText.length }]
      : [];
  return {
    ...appended,
    nextText,
    assistantOccurrences: [
      ...(previous?.assistantOccurrences ?? []),
      ...(appended.completedText
        ? source.occurrences.filter(({ key }) => streamed || !finalKey || key === finalKey)
        : []),
    ],
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
    settleResult(resultKey: string | undefined, text: string) {
      // The result envelope owns the final wording; prepare it before the first durable write.
      if (pending && pending.key === resultKey && text) {
        pending = { ...pending, text };
      }
    },
    observe(
      parsed: Record<string, unknown>,
      sessionId: string | undefined,
      claim: (key: string) => string | undefined,
    ) {
      const nextKey =
        sessionId && typeof parsed.uuid === "string" ? `${sessionId}:${parsed.uuid}` : undefined;
      if (nextKey && nextKey !== key) {
        flush();
        key = nextKey;
      }
      const segment = readClaudeSnapshotSegment(parsed, sessionId);
      if (segment?.key) {
        const id = claim(segment.key);
        const ids = pending?.assistantItemIds ?? [];
        if (id) {
          ids.push(id);
        }
        if (ids.length) {
          segment.assistantItemIds = ids;
        }
        pending = segment;
        completed = isRecord(parsed.message) && typeof parsed.message.stop_reason === "string";
      }
    },
  };
}
