/** Pure summary assembly shared by inference callers and transcript preparation workers. */
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { CompactionError, err, ok, type Result } from "../types.js";
import type { CompactionDetails } from "./compaction-details.js";
import { buildCompactionFloor } from "./compaction-floor.js";
import {
  capCompactionSummary,
  fitCompactionSummary,
  SUMMARY_TRUNCATED_MARKER,
} from "./compaction-summary-budget.js";
import type {
  CompactionPreparation,
  CompactionPreparationMetadata,
  CompactionResult,
  CompactionSummaryPrompt,
} from "./compaction.js";
import {
  clearCompactionPendingAskSection,
  computeFileLists,
  extractCompactionMessageText,
  formatCompactionUserLabel,
  formatFileOperations,
  removeGeneratedCompactionSection,
} from "./utils.js";

const TURN_CONTEXT_PREFIX = "\n\n---\n\n**Turn Context (split turn):**\n\n";
const MAX_REQUIRED_ASK_CONTEXT_CHARS = 2_000;
const REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER = "\n[... split-turn ask context truncated ...]\n";

/** Bounds a split turn's source ask; the safeguard summary and the no-summary reduction share it. */
export function formatRequiredAskContext(rawAsk: string): string {
  const source = rawAsk.trim();
  if (source.length <= MAX_REQUIRED_ASK_CONTEXT_CHARS) {
    return source;
  }
  const contentBudget =
    MAX_REQUIRED_ASK_CONTEXT_CHARS - REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${truncateUtf16Safe(source, headBudget)}${REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(source, -tailBudget)}`;
}

/** Summary assembly has one owner regardless of how bounded request text is rendered. */
export async function compactFromSource(
  preparation: CompactionPreparationMetadata,
  counts: { history: number; turnPrefix: number },
  summarize: (
    source: "history" | "turnPrefix",
    previous?: string,
    prompt?: CompactionSummaryPrompt,
  ) => Promise<Result<string, CompactionError>>,
): Promise<Result<CompactionResult, CompactionError>> {
  if (!preparation.firstKeptEntryId) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }
  const summarizeTurnPrefix = preparation.isSplitTurn && counts.turnPrefix > 0;
  const historyResult =
    counts.history > 0 || !summarizeTurnPrefix
      ? await summarize("history", preparation.previousSummary)
      : ok<string, CompactionError>(
          previousSummaryWithoutFileOperations(preparation) ?? "No prior history.",
        );
  if (!historyResult.ok) {
    return err(historyResult.error);
  }
  let latestContext = "";
  if (summarizeTurnPrefix) {
    const prefix = await summarize("turnPrefix", undefined, { kind: "turn-prefix" });
    if (!prefix.ok) {
      return err(prefix.error);
    }
    latestContext = `${TURN_CONTEXT_PREFIX}${prefix.value}`;
  }
  return finalizeCompaction(preparation, historyResult.value, latestContext);
}

/**
 * Builds the same commit-ready artifact without a model call, for when summary
 * generation failed. The prepared cut keeps the recent suffix verbatim; the
 * previous summary, a split turn's raw source ask, file operations, and the
 * unresolved request carry forward, and the dropped span is named, not summarized.
 */
export function compactWithoutSummary(
  preparation: CompactionPreparation,
): Result<CompactionResult<CompactionDetails>, CompactionError> {
  const sourceMessage = preparation.isSplitTurn
    ? preparation.turnPrefixMessages.findLast(
        (message): message is Extract<AgentMessage, { role: "user" }> =>
          message.role === "user" && Boolean(extractCompactionMessageText(message)),
      )
    : undefined;
  const sourceText = sourceMessage ? extractCompactionMessageText(sourceMessage) : "";
  const sourceLabel = sourceMessage ? formatCompactionUserLabel(sourceMessage) : "User";
  const sourceAsk = sourceMessage
    ? formatRequiredAskContext(
        sourceLabel === "User" ? sourceText : `[${sourceLabel}]: ${sourceText}`,
      )
    : "";
  return compactWithoutSummaryFromFacts(preparation, {
    droppedCount: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length,
    sourceAsk,
    floor: buildCompactionFloor([
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]),
  });
}

/** A native view supplies the selected ask, exact dropped count, and canonical floor. */
export function compactWithoutSummaryFromFacts(
  preparation: CompactionPreparationMetadata,
  { droppedCount, sourceAsk, floor }: { droppedCount: number; sourceAsk: string; floor: string },
): Result<CompactionResult<CompactionDetails>, CompactionError> {
  // Keep the notice and bounded source ask; shrink only the carried summary.
  const requiredContext =
    `[${droppedCount} earlier message(s) were removed without a summary because summarization failed. The messages after this summary are verbatim; the removed messages remain in this session's stored transcript. When session history tools are available, read them there before asking the user to repeat earlier details.]\n\n` +
    (sourceAsk ? `## Original request of the current turn\n${JSON.stringify(sourceAsk)}\n\n` : "");
  // The floor leads the shrinkable body, so a constrained budget trims the carried summary first.
  const carriedSummary = previousSummaryWithoutFileOperations(preparation) ?? "";
  return finalizeCompaction(
    preparation,
    [floor, carriedSummary].filter(Boolean).join("\n\n"),
    "",
    requiredContext,
  );
}

// File metadata is re-merged by finalizeCompaction, so the carried summary drops its old copy.
function previousSummaryWithoutFileOperations(
  preparation: CompactionPreparationMetadata,
): string | undefined {
  const { previousSummary, previousSummaryDetails } = preparation;
  const previousRequest = previousSummaryDetails?.latestUnresolvedUserRequest;
  const previousRequestSection = previousRequest
    ? `## Latest unresolved user request\n${JSON.stringify(previousRequest)}\n\n`
    : "";
  const summaryWithoutRequest =
    preparation.requestSelection !== undefined && previousRequestSection
      ? removeGeneratedCompactionSection(previousSummary, previousRequestSection)
      : previousSummary;
  const reconciledSummary =
    preparation.requestSelection?.state === "none" && summaryWithoutRequest
      ? clearCompactionPendingAskSection(summaryWithoutRequest)
      : summaryWithoutRequest;
  const previousFileOperations = previousSummaryDetails
    ? formatFileOperations(previousSummaryDetails.readFiles, previousSummaryDetails.modifiedFiles)
    : "";
  return previousFileOperations && reconciledSummary?.endsWith(previousFileOperations)
    ? reconciledSummary.slice(0, -previousFileOperations.length)
    : reconciledSummary;
}

function finalizeCompaction(
  preparation: CompactionPreparationMetadata,
  historySummary: string,
  latestContext: string,
  requiredContext = "",
): Result<CompactionResult<CompactionDetails>, CompactionError> {
  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  const fileOperations = formatFileOperations(readFiles, modifiedFiles);
  // Required prefix content survives fitting; only the history and split-turn context shrink.
  const requiredPrefix = `${requiredContext}${
    preparation.latestUnresolvedUserRequest
      ? `## Latest unresolved user request\n${JSON.stringify(preparation.latestUnresolvedUserRequest)}\n\n`
      : ""
  }`;
  const fitted = fitCompactionSummary(
    preparation.summaryTokenBudget,
    (maxChars) => {
      const requiredChars = fileOperations.length + requiredPrefix.length;
      if (maxChars <= requiredChars + SUMMARY_TRUNCATED_MARKER.length) {
        return undefined;
      }
      const preservedHistoryChars = Math.min(
        historySummary.length,
        Math.floor(
          (preparation.summaryTokenBudget === undefined ? maxChars : maxChars - requiredChars) / 2,
        ),
      );
      const latestContextBudget =
        maxChars - requiredChars - SUMMARY_TRUNCATED_MARKER.length - preservedHistoryChars;
      // Fitting must keep generated split-turn context beside required metadata,
      // including its heading and loss marker when that context is shortened.
      if (
        preparation.summaryTokenBudget !== undefined &&
        latestContext &&
        latestContextBudget < TURN_CONTEXT_PREFIX.length + SUMMARY_TRUNCATED_MARKER.length + 1
      ) {
        return undefined;
      }
      const suffix = `${latestContextBudget > 0 ? capCompactionSummary(latestContext, latestContextBudget) : ""}${fileOperations}`;
      return {
        summary: `${requiredPrefix}${capCompactionSummary(
          `${historySummary}${suffix}`,
          maxChars - requiredPrefix.length,
          suffix,
        )}`,
      };
    },
    preparation.settings.maxSummaryChars,
  );
  if (!fitted.ok) {
    return fitted;
  }

  return ok({
    summary: fitted.value.summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: {
      readFiles,
      modifiedFiles,
      ...(preparation.latestUnresolvedUserRequest
        ? { latestUnresolvedUserRequest: preparation.latestUnresolvedUserRequest }
        : {}),
    },
  });
}
