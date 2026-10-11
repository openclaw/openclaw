// Where a Claude reply's candidate text starts inside the parser's assembled
// assistant text, and which candidate a terminal result keeps. Kept beside
// `cli-output-stream.ts` so the parser stays within the file-size budget, and
// shared with the post-budget watcher in `cli-output-stream-budget.ts`: once a
// spent budget stops assembly, these facts still have to follow the stream, or
// the terminal result is judged against a message that has long since ended.
import {
  missingMessageBoundarySeparator,
  preferStreamedClaudeTextOverResult,
} from "./cli-output-records.js";

export function createClaudeReplyBoundary() {
  let pendingMessageSeparator = false;
  let sawToolUseSinceText = false;
  let currentMessageHadToolUse = false;
  let previousMessageHadToolUse = false;
  let currentMessageStart = 0;
  let segmentStart = 0;
  // Streamed text from this offset on is still a candidate to outrank the
  // result envelope; every non-tool boundary or interim result restarts it.
  let preserveFrom = 0;
  // Past a spent budget: text of the final message arrived but was not assembled.
  let textDropped = false;

  const settleText = (assistantText: string, delta: string): string => {
    // A tool_use block starts a new post-tool segment even inside one assistant
    // message; only tool-split boundaries may later outrank the result envelope.
    // A message boundary is a tool split only when the PREVIOUS message used a
    // tool: a tool-first fresh message must not connect an earlier draft, while
    // a tool-using message keeps its text connected across its own boundary.
    const boundaryPending = pendingMessageSeparator || sawToolUseSinceText;
    const isToolSplitBoundary = pendingMessageSeparator
      ? previousMessageHadToolUse
      : sawToolUseSinceText;
    const separator =
      boundaryPending && assistantText ? missingMessageBoundarySeparator(assistantText, delta) : "";
    if (boundaryPending && assistantText) {
      currentMessageStart = assistantText.length + separator.length;
      // Text before a non-tool boundary may be a superseded draft; only text
      // connected to the result through tool splits stays a candidate.
      if (!isToolSplitBoundary) {
        preserveFrom = currentMessageStart;
      }
    }
    pendingMessageSeparator = false;
    sawToolUseSinceText = false;
    return separator;
  };

  return {
    /**
     * Applies the boundary pending ahead of text starting with `delta` and
     * returns the separator that text needs before it is appended.
     */
    settleText,
    /**
     * The same boundary for text a spent budget no longer assembles, so the
     * terminal result still knows where the final message starts. `settle` is
     * false when pre-tool text is commentary rather than reply.
     */
    dropText(assistantText: string, delta: string, settle: boolean): void {
      textDropped = true;
      if (settle) {
        settleText(assistantText, delta);
      }
    },
    beginMessage(): void {
      pendingMessageSeparator = true;
      previousMessageHadToolUse = currentMessageHadToolUse;
      currentMessageHadToolUse = false;
    },
    markToolUse(): void {
      sawToolUseSinceText = true;
      currentMessageHadToolUse = true;
    },
    /**
     * An interim result commits its segment. Rebase boundary state so later
     * text is judged on its own, while delta snapshots stay cumulative.
     */
    rebase(offset: number): void {
      segmentStart = offset;
      currentMessageStart = offset;
      preserveFrom = offset;
      pendingMessageSeparator = false;
      sawToolUseSinceText = false;
      currentMessageHadToolUse = false;
      previousMessageHadToolUse = false;
    },
    /** The reply a terminal result settles on, before result-envelope fallbacks. */
    resolveReplyText(params: {
      assistantText: string;
      resultText: string;
      fallbackText: () => string;
    }): string {
      const { assistantText, resultText } = params;
      const postBudget = joinPostBudgetReplyText({
        textDropped,
        assistantText,
        preserveFrom,
        currentMessageStart,
        resultText,
      });
      if (postBudget !== undefined) {
        return postBudget.trim();
      }
      // Empty terminal result can follow already-streamed text; keep that text.
      const streamedText = assistantText.slice(segmentStart).trim();
      const preservedCandidate = assistantText.slice(preserveFrom).trim();
      const keepStreamed = preferStreamedClaudeTextOverResult({
        streamedText: preservedCandidate,
        finalMessageText: assistantText.slice(currentMessageStart).trim(),
        resultText,
      });
      return (
        keepStreamed ? preservedCandidate : resultText || streamedText || params.fallbackText()
      ).trim();
    },
  };
}

/**
 * The reply for a terminal result reached after the spent budget dropped part
 * of the final message. That partial message is no candidate any more; the
 * result carries its text. What is still owed is the assembled text a tool
 * split connects to it — `[preserveFrom, currentMessageStart)` — exactly the
 * pre-tool text an unbudgeted turn keeps ahead of the final message. Returns
 * undefined when nothing was dropped, so ordinary selection applies.
 */
function joinPostBudgetReplyText(params: {
  textDropped: boolean;
  assistantText: string;
  preserveFrom: number;
  currentMessageStart: number;
  resultText: string;
}): string | undefined {
  if (!params.textDropped || !params.resultText) {
    return undefined;
  }
  const connected = params.assistantText
    .slice(params.preserveFrom, params.currentMessageStart)
    .trim();
  if (!connected || params.resultText.startsWith(connected)) {
    return params.resultText;
  }
  const separator = missingMessageBoundarySeparator(connected, params.resultText);
  return `${connected}${separator}${params.resultText}`;
}
