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
import { decodeCliRecords, readClaudeAttributedSubagentProgressId } from "./cli-output-records.js";
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
     * Records a line, classifies whether this turn pays for it, and returns
     * false once the cumulative line budget is spent. An uncharged line still
     * counts as output seen, so a turn carrying only discarded traffic is not
     * mistaken for a stream that produced nothing.
     */
    observeLine(line: string, claudeStreamJson: boolean): boolean {
      observedLines += 1;
      chargeable = !claudeStreamJson || !isClaudeSubagentJsonlLine(line);
      if (!chargeable) {
        return true;
      }
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
}): (line: string) => void {
  const projectProgress = (record: Record<string, unknown>) => {
    const attributedParentToolUseId = readClaudeAttributedSubagentProgressId(record);
    if (attributedParentToolUseId) {
      params.onAttributedSubagentProgress?.(attributedParentToolUseId);
      return;
    }
    dispatchClaudeCliStreamingToolEvent({
      backend: params.backend,
      providerId: params.providerId,
      parsed: record,
      tracker: params.tracker,
      onToolUseStart: params.onToolUseStart,
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
