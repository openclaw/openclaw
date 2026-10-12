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
import type {
  CliBackendConfig,
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../plugins/cli-backend.types.js";
import type { CliStreamJsonOutputLimits } from "./cli-output-contracts.js";
import {
  decodeCliRecords,
  missingMessageBoundarySeparator,
  preferStreamedClaudeTextOverResult,
} from "./cli-output-records.js";
import { streamJsonOutputLimitErrorText } from "./cli-output-stream-limits.js";

/**
 * Picks a terminal result's reply text from the streamed boundary state.
 *
 * On an unbudgeted turn this is the established precedence: the envelope wins
 * unless it merely restates the final streamed message, in which case the whole
 * tool-split-connected candidate wins.
 *
 * On a truncated turn the closing message was never assembled, so that
 * comparison cannot see it and the envelope would erase the reply text already
 * assembled. Text a tool split connects to the answer — a tool outstanding, or
 * a split already applied — is kept as a bounded prefix instead; a draft with
 * no tool split stays superseded exactly as on an unbudgeted turn. The in-flight
 * message is dropped when the envelope restates it, so a budget spent mid-message
 * cannot duplicate text.
 */
export function resolveCliTerminalReplyText(params: {
  assistantText: string;
  segmentStart: number;
  preserveFrom: number;
  currentMessageStart: number;
  preservedTextHasToolSplit: boolean;
  resultText: string;
  fallbackText: string;
}): string {
  const { assistantText, preserveFrom, currentMessageStart, resultText } = params;
  const preservedCandidate = assistantText.slice(preserveFrom).trim();
  const finalMessageText = assistantText.slice(currentMessageStart).trim();
  if (
    preferStreamedClaudeTextOverResult({
      streamedText: preservedCandidate,
      finalMessageText,
      resultText,
    })
  ) {
    return preservedCandidate.trim();
  }
  const truncatedPrefix =
    params.preservedTextHasToolSplit && resultText
      ? assistantText
          .slice(
            preserveFrom,
            finalMessageText && resultText.startsWith(finalMessageText)
              ? currentMessageStart
              : assistantText.length,
          )
          .trim()
      : "";
  if (truncatedPrefix) {
    const separator = missingMessageBoundarySeparator(truncatedPrefix, resultText);
    return `${truncatedPrefix}${separator}${resultText}`.trim();
  }
  // Empty terminal result can follow already-streamed text; keep that text.
  const streamedText = assistantText.slice(params.segmentStart).trim();
  return (resultText || streamedText || params.fallbackText).trim();
}

function streamJsonOutputTruncationText(kind: "raw" | "lines", limit: number): string {
  const measure = kind === "lines" ? `${limit} lines` : `${limit} characters`;
  return `CLI JSONL output exceeded ${measure}; stopped assembling output and kept watching for the terminal result.`;
}

export function createCliStreamJsonTurnBudget(limits: CliStreamJsonOutputLimits) {
  let spent: { kind: "raw" | "lines"; limit: number } | null = null;
  let rawChars = 0;
  let rawLines = 0;
  let observedLines = 0;
  return {
    /**
     * Every frame the parser saw, including the ones the odometers discount.
     * Output presence is a fact about the stream, not about what was charged.
     */
    observe(): void {
      observedLines += 1;
    },
    /** False once the cumulative character budget is spent. */
    chargeChars(chars: number): boolean {
      rawChars += chars;
      if (rawChars <= limits.maxTurnRawChars) {
        return true;
      }
      spent ??= { kind: "raw", limit: limits.maxTurnRawChars };
      return false;
    },
    /** False once the cumulative line budget is spent. */
    chargeLine(): boolean {
      rawLines += 1;
      if (rawLines <= limits.maxTurnLines) {
        return true;
      }
      spent ??= { kind: "lines", limit: limits.maxTurnLines };
      return false;
    },
    get exhausted(): boolean {
      return spent !== null;
    },
    get observedLines(): number {
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

/**
 * Charges one ordinary Claude frame — blank, hook-handled and built-in record
 * alike — to both odometers, which is the documented bounded-frame contract
 * (docs/gateway/cli-backends.md). Only recognized partial-message deltas are
 * exempt from the line odometer; their characters are charged by the caller.
 * The frame that exhausts a budget may itself be the terminal result, so it is
 * handed to the watcher; pass "" when the caller dispatches that itself.
 */
export function createOrdinaryClaudeLineAccountant(
  budget: ReturnType<typeof createCliStreamJsonTurnBudget>,
  watchForTerminalResult: (line: string) => void,
): (line: string, retainedChars: number) => boolean {
  return (line, retainedChars) => {
    if (budget.chargeLine() && budget.chargeChars(retainedChars + 1)) {
      return true;
    }
    watchForTerminalResult(line);
    return false;
  };
}

export function forEachTerminalResultEvent(
  parsed: CliBackendParsedJsonlEvent | readonly CliBackendParsedJsonlEvent[],
  handle: (event: CliBackendParsedJsonlEvent) => void,
): void {
  for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
    if (event.kind === "result") {
      handle(event);
    }
  }
}

/**
 * Decodes each post-budget line only far enough to recognize the terminal
 * result, so a finished run still reports its answer while retention stays flat.
 */
export function createClaudeTerminalResultWatcher(params: {
  backend: CliBackendConfig;
  providerId: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  hasTerminalResult: () => boolean;
  onResultEvents: (
    parsed: CliBackendParsedJsonlEvent | readonly CliBackendParsedJsonlEvent[],
  ) => void;
  onResultRecord: (record: Record<string, unknown>) => void;
}): (line: string) => void {
  return (line: string) => {
    // A terminal record always names `result`; skipping the rest avoids paying
    // JSON parsing for a stream that is no longer being assembled.
    if (!line || params.hasTerminalResult() || !line.includes("result")) {
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
        params.onResultEvents(parsed);
        return;
      }
    }
    for (const record of decodeCliRecords(line)) {
      if (record.type === "result" && record.openclaw_interim_result !== true) {
        params.onResultRecord(record);
      }
    }
  };
}
