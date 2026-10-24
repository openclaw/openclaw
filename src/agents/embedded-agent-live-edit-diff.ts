import { parseStreamingJson } from "@openclaw/ai/internal/runtime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { countStreamingFileMutationLines } from "./file-mutation-args.js";
import { resolveFileMutationToolName } from "./tool-mutation-names.js";

const LIVE_EDIT_DIFF_MIN_INTERVAL_MS = 250;
const LIVE_EDIT_DIFF_MAX_PARTIAL_JSON_CHARS = 1024 * 1024;
const LIVE_EDIT_DIFF_MAX_TRACKED_CALLS = 64;

export type LiveEditDiffProgressState = {
  added: number;
  removed: number;
  emittedAdded: number;
  emittedRemoved: number;
  emittedInputChars: number;
  lastCheckedAtMs: number;
};

export type LiveEditDiffProgress = {
  toolCallId: string;
  name: string;
  /** Length of the streamed argument JSON so far. Counts only, never content. */
  inputChars: number;
  /** Best-effort line counts, present only for file-mutation tools. */
  diff?: { added: number; removed: number };
};

function readToolCallBlock(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const contentIndex = event.contentIndex;
  const partial = event.partial;
  if (
    typeof contentIndex !== "number" ||
    !Number.isInteger(contentIndex) ||
    contentIndex < 0 ||
    !partial ||
    typeof partial !== "object"
  ) {
    return undefined;
  }
  const content = (partial as { content?: unknown }).content;
  return asOptionalRecord(Array.isArray(content) ? content[contentIndex] : undefined);
}

function readToolCallId(event: Record<string, unknown>): string | undefined {
  const id = asOptionalRecord(event.toolCall)?.id;
  if (typeof id === "string" && id) {
    return id;
  }
  const block = readToolCallBlock(event);
  return typeof block?.id === "string" && block.id ? block.id : undefined;
}

/**
 * Update one run's bounded, throttled progress for a tool call whose input is
 * still streaming. Every tool reports the streamed input length, so a long
 * argument stays visibly alive; file-mutation tools also report line counts.
 */
export function updateLiveEditDiffProgress(
  stateByToolCallId: Map<string, LiveEditDiffProgressState>,
  event: Record<string, unknown> | undefined,
): LiveEditDiffProgress | undefined {
  if (!event) {
    return undefined;
  }
  const eventType = event.type;

  if (eventType === "toolcall_end") {
    const toolCallId = readToolCallId(event);
    if (toolCallId) {
      stateByToolCallId.delete(toolCallId);
    }
    return undefined;
  }
  if (eventType !== "toolcall_delta") {
    return undefined;
  }

  const block = readToolCallBlock(event);
  const toolCallId = typeof block?.id === "string" ? block.id : "";
  const name = typeof block?.name === "string" ? block.name : "";
  // partialJson is the producer's live buffer, not a per-event snapshot. A lagging reader sees a
  // newer value (counts only move forward) or none after toolcall_end (skipped); accepted for progress.
  const partialJson = typeof block?.partialJson === "string" ? block.partialJson : "";
  return updateLiveEditDiffProgressFromInput(stateByToolCallId, {
    toolCallId,
    name,
    partialJsonLength: partialJson.length,
    readPartialJson: () => partialJson,
  });
}

/** Share bounded counting without assembling cumulative CLI arguments before admission. */
export function updateLiveEditDiffProgressFromInput(
  stateByToolCallId: Map<string, LiveEditDiffProgressState>,
  input: {
    toolCallId: string;
    name: string;
    partialJsonLength: number;
    readPartialJson: () => string;
  },
): LiveEditDiffProgress | undefined {
  const { toolCallId, name, partialJsonLength } = input;
  if (!toolCallId || !name || !partialJsonLength) {
    return undefined;
  }

  let progress = stateByToolCallId.get(toolCallId);
  if (!progress) {
    if (stateByToolCallId.size >= LIVE_EDIT_DIFF_MAX_TRACKED_CALLS) {
      return undefined;
    }
    progress = {
      added: 0,
      removed: 0,
      emittedAdded: 0,
      emittedRemoved: 0,
      emittedInputChars: 0,
      lastCheckedAtMs: 0,
    };
    stateByToolCallId.set(toolCallId, progress);
  }

  const now = Date.now();
  if (
    progress.lastCheckedAtMs > 0 &&
    now - progress.lastCheckedAtMs < LIVE_EDIT_DIFF_MIN_INTERVAL_MS
  ) {
    return undefined;
  }
  progress.lastCheckedAtMs = now;
  const kind = resolveFileMutationToolName(name);
  // Parsing is the expensive part: only file-mutation tools read and parse the
  // cumulative input, after the throttle and under the size cap, so fragmented
  // large arguments cannot create quadratic work on the event path. Past the cap
  // the line counts stay frozen while the length keeps reporting progress.
  if (kind && partialJsonLength <= LIVE_EDIT_DIFF_MAX_PARTIAL_JSON_CHARS) {
    const counted = countStreamingFileMutationLines(
      kind,
      parseStreamingJson(input.readPartialJson()),
    );
    // Streaming parses are best effort. Never move a visible counter backwards if
    // an incomplete JSON boundary temporarily exposes less of the same arguments.
    progress.added = Math.max(progress.added, counted.added);
    progress.removed = Math.max(progress.removed, counted.removed);
  }
  const inputChars = Math.max(progress.emittedInputChars, partialJsonLength);
  if (
    inputChars === progress.emittedInputChars &&
    progress.added === progress.emittedAdded &&
    progress.removed === progress.emittedRemoved
  ) {
    return undefined;
  }
  progress.emittedInputChars = inputChars;
  progress.emittedAdded = progress.added;
  progress.emittedRemoved = progress.removed;
  return {
    toolCallId,
    name: normalizeLowercaseStringOrEmpty(name),
    inputChars,
    ...(kind ? { diff: { added: progress.added, removed: progress.removed } } : {}),
  };
}
