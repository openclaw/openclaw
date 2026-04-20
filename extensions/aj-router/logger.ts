/**
 * Routing decision logger. Writes one JSONL record per routing decision to
 * `<logsDir>/routing.jsonl`, creating the directory on demand.
 *
 * The writer is fire-and-forget from the hook's perspective: errors are
 * logged through the plugin logger but never thrown, so a log-write failure
 * can never block a user request.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { isRejection, type RouteResult } from "./resolver.js";

export type LogEntry = {
  /** ISO-8601 timestamp of the routing decision. */
  timestamp: string;
  /** Source that issued the request (e.g. telegram channel id, cron id). */
  source?: string;
  /** Prompt length — never the prompt itself (avoid leaking confidential text). */
  promptLength: number;
  /** Sensitivity label applied (after defaults). */
  sensitivity: string;
  /** Classifier tier output. */
  tier: string;
  /** Classifier confidence. */
  confidence: number;
  /** Chosen alias (absent on rejection). */
  alias?: string;
  /** Chosen model reference (absent on rejection). */
  modelRef?: string;
  /** True if escalation bumped the tier. */
  escalated: boolean;
  /** True when the sensitivity gate rejected the request. */
  rejected: boolean;
  /** On rejection, human-readable reason. */
  rejectionReason?: string;
};

export type WriteEntryParams = {
  logsDir: string;
  entry: LogEntry;
};

const ROUTING_LOG_FILENAME = "routing.jsonl";

/** Build a log entry from a resolver result. */
export function toLogEntry(
  result: RouteResult,
  ctx: {
    source?: string;
    promptLength: number;
    now?: Date;
  },
): LogEntry {
  const timestamp = (ctx.now ?? new Date()).toISOString();
  if (isRejection(result)) {
    return {
      timestamp,
      source: ctx.source,
      promptLength: ctx.promptLength,
      sensitivity: result.sensitivity,
      tier: result.classification.tier,
      confidence: result.classification.confidence,
      escalated: false,
      rejected: true,
      rejectionReason: result.reason,
    };
  }
  return {
    timestamp,
    source: ctx.source,
    promptLength: ctx.promptLength,
    sensitivity: result.sensitivity,
    tier: result.classification.tier,
    confidence: result.classification.confidence,
    alias: result.alias,
    modelRef: result.modelRef,
    escalated: result.escalated,
    rejected: false,
  };
}

/**
 * Append an entry to `<logsDir>/routing.jsonl`. Creates the directory if
 * missing. Errors are returned so the caller can decide whether to surface
 * them.
 */
export async function writeEntry(params: WriteEntryParams): Promise<void> {
  await mkdir(params.logsDir, { recursive: true });
  const line = `${JSON.stringify(params.entry)}\n`;
  await appendFile(join(params.logsDir, ROUTING_LOG_FILENAME), line, "utf8");
}

export { ROUTING_LOG_FILENAME };
