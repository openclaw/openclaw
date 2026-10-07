import type { summarizeInStages } from "../compaction.js";
import "./compaction-safeguard.js";

type CompactionSafeguardTestApi = {
  setSummarizeInStagesForTest(next?: typeof summarizeInStages): void;
  collectToolFailures: CallableFunction;
  formatToolFailuresSection: CallableFunction;
  splitPreservedRecentTurns: CallableFunction;
  buildPreservedTurnsSection: CallableFunction;
  buildCompactionStructureInstructions: CallableFunction;
  prependPreviousSummaryForRedistill: CallableFunction;
  resolveRecentTurnsPreserve: CallableFunction;
  resolveQualityGuardMaxRetries: CallableFunction;
  extractOpaqueIdentifiers: CallableFunction;
  auditSummaryQuality: CallableFunction;
  capCompactionSummary: CallableFunction;
  formatFileOperations: CallableFunction;
  MAX_FILE_OPS_SECTION_CHARS: number;
  budgetCompactionSummary: CallableFunction;
  readWorkspaceContextForSummary: CallableFunction;
  MAX_COMPACTION_SUMMARY_CHARS: number;
  SUMMARY_TRUNCATED_MARKER: string;
  CONTEXT_TRUNCATED_MARKER: string;
  MAX_SPLIT_TURN_CONTEXT_CHARS: number;
};

function getTestApi(): CompactionSafeguardTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.compactionSafeguardTestApi")
  ];
  if (!api) {
    throw new Error("compaction safeguard test API is unavailable");
  }
  return api as CompactionSafeguardTestApi;
}

export const testing = getTestApi();
