// Cumulative per-turn budgets for the CLI streaming parser, kept beside
// `cli-output-stream.ts` so the parser stays within the file-size budget.
//
// `maxTurnRawChars` and `maxTurnLines` are odometers over a stream whose
// partial-message deltas and tool results are discarded as soon as they are
// assembled; neither bounds a single allocation. Abandoning the turn when one
// is spent destroys a run that actually finished, because the terminal `result`
// record arrives last. Exhausting a budget therefore marks the turn truncated,
// and the parser keeps watching for that record while assembling nothing more.
// The per-line `maxPendingLineChars` bound is unaffected and stays fatal.
//
// Only traffic the parent lane actually assembles is charged. Claude Code
// forwards subagent output on the parent's stdout for the parent to discard, so
// charging it spends a budget on bytes that never become parent output.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  CliBackendConfig,
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../plugins/cli-backend.types.js";
import type {
  CliStreamJsonOutputLimits,
  CliToolResultDelta,
  CliToolUseStartDelta,
} from "./cli-output-contracts.js";
import { dispatchClaudeCliStreamingToolEvent } from "./cli-output-events.js";
import { isClaudeSubagentJsonlLine } from "./cli-output-jsonl-scan.js";
import {
  decodeCliRecords,
  isClaudeSubagentRecord,
  isClaudeToolUseBlockType,
  readClaudeAttributedSubagentProgressId,
} from "./cli-output-records.js";
import { streamJsonOutputLimitErrorText } from "./cli-output-stream-limits.js";
import type { createToolUseTracker } from "./cli-output-tool-tracker.js";

function streamJsonOutputTruncationText(kind: "raw" | "lines", limit: number): string {
  const measure = kind === "lines" ? `${limit} lines` : `${limit} characters`;
  return `CLI JSONL output exceeded ${measure}; stopped assembling output and kept watching for the terminal result.`;
}

export function createCliStreamJsonTurnBudget(limits: CliStreamJsonOutputLimits) {
  let spent: { kind: "raw" | "lines"; limit: number } | null = null;
  let chargedChars = 0;
  let chargedLines = 0;
  let observedLines = 0;
  let chargeable = true;
  return {
    /** Whether the line most recently observed is charged to this turn. */
    get chargeable(): boolean {
      return chargeable;
    },
    /** False once the cumulative character budget is spent. */
    chargeChars(chars: number): boolean {
      chargedChars += chars;
      if (chargedChars <= limits.maxTurnRawChars) {
        return true;
      }
      spent ??= { kind: "raw", limit: limits.maxTurnRawChars };
      return false;
    },
    /**
     * Records a line and classifies whether this turn pays for it (forwarded
     * subagent traffic on the Claude path never does). An uncharged line still
     * counts as output seen, so a turn carrying only discarded traffic is not
     * mistaken for a stream that produced nothing.
     *
     * Non-Claude lines are chargeable by definition and count toward the line
     * budget immediately. Chargeable Claude lines are NOT counted here: a line
     * recognized as a partial-message delta (content_block_delta text/thinking/
     * tool-input) is discarded as soon as it's assembled and must stay exempt
     * from the line odometer too, but that classification needs the decoded
     * record, which isn't available yet at this call site. Call `chargeLine()`
     * once that's known, for every chargeable, non-partial-message Claude line.
     */
    observeLine(line: string, claudeStreamJson: boolean): boolean {
      observedLines += 1;
      chargeable = !claudeStreamJson || !isClaudeSubagentJsonlLine(line);
      if (!chargeable || claudeStreamJson) {
        return true;
      }
      chargedLines += 1;
      if (chargedLines <= limits.maxTurnLines) {
        return true;
      }
      spent ??= { kind: "lines", limit: limits.maxTurnLines };
      return false;
    },
    /**
     * Charges one line toward the cumulative line budget. Used only for a
     * chargeable Claude line once partial-message exemption is known (see
     * `observeLine`); non-Claude and subagent-forwarded lines never call this.
     */
    chargeLine(): boolean {
      chargedLines += 1;
      if (chargedLines <= limits.maxTurnLines) {
        return true;
      }
      spent ??= { kind: "lines", limit: limits.maxTurnLines };
      return false;
    },
    get exhausted(): boolean {
      return spent !== null;
    },
    get lines(): number {
      return observedLines;
    },
    /** A spent budget is only fatal while the turn's outcome stays unknowable. */
    errorText(terminalResultRecovered: boolean): string {
      return spent && !terminalResultRecovered
        ? streamJsonOutputLimitErrorText(spent.kind, spent.limit)
        : "";
    },
    truncationText(terminalResultRecovered: boolean): string | null {
      return spent && terminalResultRecovered
        ? streamJsonOutputTruncationText(spent.kind, spent.limit)
        : null;
    },
  };
}

/** Routes the terminal `result` event of a decoded batch, and nothing else. */
export function createTerminalResultEventDispatcher(
  handle: (event: CliBackendParsedJsonlEvent) => void,
): (parsed: CliBackendParsedJsonlEvent | readonly CliBackendParsedJsonlEvent[]) => void {
  return (parsed) => {
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      if (event.kind === "result") {
        handle(event);
      }
    }
  };
}

/**
 * Reply-shape facts of parent records past a spent budget. No text is assembled
 * any more, but which already-assembled text the terminal result keeps still
 * depends on where the final message starts and whether tool splits connect it
 * to that text — the same facts the parser tracks before the budget is spent.
 */
export type ClaudePostBudgetReplyBoundaries = {
  onMessageStart: (messageId: string | undefined) => void;
  onAssistantMessageId: (messageId: string) => void;
  onToolUse: () => void;
  /** A parent record that may carry text the spent budget no longer assembles. */
  onText: (record: Record<string, unknown>) => void;
};

function observePostBudgetReplyBoundaries(
  boundaries: ClaudePostBudgetReplyBoundaries,
  record: Record<string, unknown>,
): void {
  // Forwarded child traffic never shapes the parent's reply.
  if (isClaudeSubagentRecord(record)) {
    return;
  }
  const message = isRecord(record.message) ? record.message : undefined;
  if (record.type === "assistant" && typeof message?.id === "string" && message.id) {
    boundaries.onAssistantMessageId(message.id);
  }
  const event = record.type === "stream_event" && isRecord(record.event) ? record.event : undefined;
  if (event?.type === "message_start") {
    const started = isRecord(event.message) ? event.message : undefined;
    boundaries.onMessageStart(typeof started?.id === "string" ? started.id : undefined);
  } else if (
    event?.type === "content_block_start" &&
    isRecord(event.content_block) &&
    isClaudeToolUseBlockType(event.content_block.type)
  ) {
    boundaries.onToolUse();
  }
  boundaries.onText(record);
}

/**
 * Handles each post-budget line. Assembly has stopped, but the process is still
 * running: tool starts, tool results and attributed subagent progress are the
 * only facts the gateway's stall detector reads once a tool is active, so they
 * must keep flowing or a healthy run is recovered as a blocked one. Only the
 * terminal result is assembled; every other record is projected to its consumer
 * and dropped, so retention stays flat. Decoding each line costs a parse the
 * budget no longer wants to pay, but no cheaper filter can recognize a progress
 * record without risking the silent liveness loss this exists to prevent.
 */
export function createClaudePostBudgetWatcher(params: {
  backend: CliBackendConfig;
  providerId: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  hasTerminalResult: () => boolean;
  onResultEvents: (
    parsed: CliBackendParsedJsonlEvent | readonly CliBackendParsedJsonlEvent[],
  ) => void;
  onResultRecord: (record: Record<string, unknown>) => void;
  tracker: ReturnType<typeof createToolUseTracker>;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onAttributedSubagentProgress?: (parentToolUseId: string) => void;
  boundaries?: ClaudePostBudgetReplyBoundaries;
}): (line: string) => void {
  const boundaries = params.boundaries;
  const projectProgress = (record: Record<string, unknown>) => {
    const attributedParentToolUseId = readClaudeAttributedSubagentProgressId(record);
    if (attributedParentToolUseId) {
      params.onAttributedSubagentProgress?.(attributedParentToolUseId);
      return;
    }
    if (boundaries) {
      observePostBudgetReplyBoundaries(boundaries, record);
    }
    // As before the budget: a tool started by an assistant snapshot splits the
    // message it belongs to. The tracker reports each start once.
    const onToolUseStart =
      boundaries && record.type === "assistant"
        ? (tool: CliToolUseStartDelta) => {
            boundaries.onToolUse();
            params.onToolUseStart?.(tool);
          }
        : params.onToolUseStart;
    dispatchClaudeCliStreamingToolEvent({
      backend: params.backend,
      providerId: params.providerId,
      parsed: record,
      tracker: params.tracker,
      onToolUseStart,
      onToolResult: params.onToolResult,
    });
  };
  return (line: string) => {
    if (!line) {
      return;
    }
    if (params.parseJsonlEvent) {
      let parsed: ReturnType<CliBackendParseJsonlEvent>;
      try {
        parsed = params.parseJsonlEvent(line, {
          backendId: params.providerId,
          backend: params.backend,
        });
      } catch {
        return;
      }
      if (parsed != null) {
        if (!params.hasTerminalResult()) {
          params.onResultEvents(parsed);
        }
        return;
      }
    }
    for (const record of decodeCliRecords(line)) {
      projectProgress(record);
      if (
        !params.hasTerminalResult() &&
        record.type === "result" &&
        record.openclaw_interim_result !== true
      ) {
        params.onResultRecord(record);
      }
    }
  };
}
