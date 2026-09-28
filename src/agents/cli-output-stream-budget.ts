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
import { decodeCliRecords } from "./cli-output-records.js";
import { streamJsonOutputLimitErrorText } from "./cli-output-stream-limits.js";

function streamJsonOutputTruncationText(kind: "raw" | "lines", limit: number): string {
  const measure = kind === "lines" ? `${limit} lines` : `${limit} characters`;
  return `CLI JSONL output exceeded ${measure}; stopped assembling output and kept watching for the terminal result.`;
}

export function createCliStreamJsonTurnBudget(limits: CliStreamJsonOutputLimits) {
  let spent: { kind: "raw" | "lines"; limit: number } | null = null;
  let rawChars = 0;
  let rawLines = 0;
  return {
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
    get lines(): number {
      return rawLines;
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
