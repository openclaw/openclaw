// The Claude stream-json tool-use tracker and the bounds on what it retains.
// Split out of `cli-output-events.ts` so both stay within the 700-line
// `max-lines` budget; nothing here changed behavior in the move.
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";

type PendingToolUse = {
  toolCallId: string;
  name: string;
  kind: CliToolUseStartDelta["kind"];
  inputJsonParts: string[];
  /** Set once buffering stopped, so the partial join is never parsed. */
  inputJsonDropped?: boolean;
  /**
   * Complete input carried on `content_block_start`. Some CLI backends send the
   * whole tool input there and never emit `input_json_delta` chunks, so without
   * this the start event reports empty args and the later complete copy is
   * dropped by the `startedIds` dedup in `emitToolStartOnce`.
   */
  blockInput?: Record<string, unknown>;
  /**
   * Exactly what this entry has added to `ToolUseTracker.pendingInputChars` —
   * the `blockInput` snapshot plus the buffered fragments — so releasing it
   * refunds everything it charged and nothing it did not.
   */
  chargedChars: number;
};

export type ToolUseTracker = {
  pendingByIndex: Map<number, PendingToolUse>;
  nameById: Map<string, string>;
  startedIds: Set<string>;
  resultDeliveredIds: Set<string>;
  pendingInputChars: number;
};

// Nothing else bounds this tracker. Its dedup ids grow once per distinct tool
// call and its `input_json_delta` fragments accumulate until a matching
// `content_block_stop` arrives, so a turn that streams tool calls indefinitely —
// or one unfinished call that streams arguments indefinitely — retains the whole
// stream. The cumulative turn budget used to cap that indirectly; it no longer
// does, because an exhausted budget keeps the parser watching for the terminal
// result instead of abandoning the turn. These caps are the direct bound.
//
// Eviction is FIFO and its worst case is a re-emitted start or result for a tool
// that last appeared thousands of calls earlier; unbounded growth instead
// retains every tool id and argument fragment for the life of the process.
const MAX_TRACKED_TOOL_IDS = 4096;
const MAX_PENDING_TOOL_BLOCKS = 256;
// Matches the per-turn raw-character budget: buffered tool arguments may not
// outgrow the traffic a whole turn is allowed to be charged for. Every char of
// tool *input* a pending block retains is charged here — the
// `content_block_start` snapshot as well as the `input_json_delta` fragments
// that supersede it — because the block-count cap alone bounds nothing:
// `maxPendingLineChars` admits an individual line approaching this same 8 MiB,
// so 256 near-limit start snapshots would retain gigabytes while spending none
// of the aggregate budget.
//
// Identifiers (`toolCallId`, `name`) are deliberately NOT charged. Every
// increment below is gated on staying under this cap, which is what makes
// `pendingInputChars <= MAX_PENDING_TOOL_INPUT_CHARS` an exact invariant rather
// than one the entry overhead can quietly exceed; identifier retention is
// count-bounded instead, uniformly with `nameById` and `startedIds`.
const MAX_PENDING_TOOL_INPUT_CHARS = 8 * 1024 * 1024;

function evictOldestUntilBounded(entries: Set<string> | Map<string, string>, max: number): void {
  while (entries.size > max) {
    const oldest = entries.keys().next();
    if (oldest.done) {
      return;
    }
    entries.delete(oldest.value);
  }
}

export function releasePendingToolUse(
  tracker: ToolUseTracker,
  index: number,
): PendingToolUse | undefined {
  const pending = tracker.pendingByIndex.get(index);
  if (!pending) {
    return undefined;
  }
  tracker.pendingByIndex.delete(index);
  tracker.pendingInputChars -= pending.chargedChars;
  pending.chargedChars = 0;
  return pending;
}

export function beginPendingToolUse(
  tracker: ToolUseTracker,
  index: number,
  init: {
    toolCallId: string;
    name: string;
    kind: CliToolUseStartDelta["kind"];
    blockInput?: Record<string, unknown>;
  },
): void {
  releasePendingToolUse(tracker, index);
  const pending: PendingToolUse = {
    toolCallId: init.toolCallId,
    name: init.name,
    kind: init.kind,
    inputJsonParts: [],
    chargedChars: 0,
  };
  tracker.pendingByIndex.set(index, pending);
  for (const oldestIndex of tracker.pendingByIndex.keys()) {
    if (tracker.pendingByIndex.size <= MAX_PENDING_TOOL_BLOCKS) {
      break;
    }
    releasePendingToolUse(tracker, oldestIndex);
  }
  if (init.blockInput) {
    // Charged only after the block-count eviction above has refunded whatever
    // it dropped, so the newest block's input is measured against the room that
    // actually remains rather than losing to stale blocks already on their way
    // out. The snapshot is retained for the life of the block exactly like the
    // fragments that replace it, so it is charged the same way: its serialized
    // length, which is the length of the stream text it came from. Over the cap
    // only the snapshot is dropped — the entry stays, so the block still settles
    // into a tool start (with `{}` args) and the start, result and attributed
    // progress the stall detector reads keep flowing.
    const snapshotChars = JSON.stringify(init.blockInput).length;
    if (tracker.pendingInputChars + snapshotChars <= MAX_PENDING_TOOL_INPUT_CHARS) {
      pending.blockInput = init.blockInput;
      pending.chargedChars = snapshotChars;
      tracker.pendingInputChars += snapshotChars;
    }
  }
}

export function appendPendingToolInput(
  tracker: ToolUseTracker,
  index: number,
  partial: string,
): void {
  const pending = tracker.pendingByIndex.get(index);
  if (!pending || pending.inputJsonDropped) {
    return;
  }
  if (tracker.pendingInputChars + partial.length > MAX_PENDING_TOOL_INPUT_CHARS) {
    // A truncated fragment list cannot parse anyway, so release it and fall
    // back to the `content_block_start` snapshot when the block finally stops.
    let bufferedChars = 0;
    for (const part of pending.inputJsonParts) {
      bufferedChars += part.length;
    }
    tracker.pendingInputChars -= bufferedChars;
    pending.chargedChars -= bufferedChars;
    pending.inputJsonParts.length = 0;
    pending.inputJsonDropped = true;
    return;
  }
  pending.inputJsonParts.push(partial);
  pending.chargedChars += partial.length;
  tracker.pendingInputChars += partial.length;
}

export function createToolUseTracker(): ToolUseTracker {
  return {
    pendingByIndex: new Map(),
    nameById: new Map(),
    startedIds: new Set(),
    resultDeliveredIds: new Set(),
    pendingInputChars: 0,
  };
}

export function emitToolStartOnce(
  tracker: ToolUseTracker,
  toolCallId: string,
  name: string,
  kind: CliToolUseStartDelta["kind"],
  args: Record<string, unknown>,
  onToolUseStart?: (delta: CliToolUseStartDelta) => void,
): void {
  // Streaming and final assistant records may both describe the same tool call.
  if (tracker.startedIds.has(toolCallId)) {
    return;
  }
  tracker.startedIds.add(toolCallId);
  evictOldestUntilBounded(tracker.startedIds, MAX_TRACKED_TOOL_IDS);
  tracker.nameById.set(toolCallId, name);
  evictOldestUntilBounded(tracker.nameById, MAX_TRACKED_TOOL_IDS);
  onToolUseStart?.({ toolCallId, name, kind, args });
}

export function emitToolResultOnce(
  tracker: ToolUseTracker,
  toolCallId: string,
  isError: boolean,
  result: unknown,
  onToolResult?: (delta: CliToolResultDelta) => void,
): void {
  // Tool results can arrive as assistant result blocks or echoed user tool_result blocks.
  if (tracker.resultDeliveredIds.has(toolCallId)) {
    return;
  }
  tracker.resultDeliveredIds.add(toolCallId);
  evictOldestUntilBounded(tracker.resultDeliveredIds, MAX_TRACKED_TOOL_IDS);
  onToolResult?.({
    toolCallId,
    name: tracker.nameById.get(toolCallId) ?? "",
    isError,
    result,
  });
}
