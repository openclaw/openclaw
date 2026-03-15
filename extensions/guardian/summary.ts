/**
 * Rolling conversation summary generation.
 *
 * Inspired by mem0's approach: instead of feeding all raw turns to the
 * guardian, we maintain a compact rolling summary of what the user has
 * been requesting. This reduces token usage and provides long-term
 * context that would otherwise be lost.
 *
 * The summary is generated asynchronously (fire-and-forget) after each
 * `llm_input` hook, so it never blocks tool call review.
 */

import type { GuardianLogger, TextCallParams } from "./guardian-client.js";
import { callForText } from "./guardian-client.js";
import type { ConversationTurn, ResolvedGuardianModel } from "./types.js";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You summarize what a USER has been requesting in a conversation with an AI assistant.

Focus on:
- What tasks/actions the user has requested
- What files, systems, or services the user is working with
- Any standing instructions the user gave ("always do X", "don't touch Y")
- Confirmations the user gave for proposed actions

Do NOT include:
- The assistant's internal reasoning or tool call details
- Exact file contents or command outputs
- Conversational filler or greetings

Output a concise paragraph (2-4 sentences max). If the conversation is very short, keep it to 1 sentence.`;

function buildInitialSummaryPrompt(turns: ConversationTurn[]): string {
  const formatted = formatTurnsForSummary(turns);
  return `Summarize the user's requests from this conversation:\n\n${formatted}`;
}

function buildUpdateSummaryPrompt(existingSummary: string, newTurns: ConversationTurn[]): string {
  const formatted = formatTurnsForSummary(newTurns);
  return `Current summary:\n${existingSummary}\n\nNew conversation turns:\n${formatted}\n\nWrite an updated summary that incorporates the new information. Keep it concise (2-4 sentences). Drop details about completed subtasks unless they inform future intent.`;
}

/**
 * Filter out trivial/system-like turns that would pollute the summary.
 * Heartbeat probes, health checks, and very short non-conversational
 * messages are excluded.
 */
function filterMeaningfulTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.filter((turn) => {
    const text = turn.user.trim().toLowerCase();
    // Skip very short messages that are likely system pings
    if (text.length < 3) return false;
    // Skip known system/heartbeat patterns
    if (/^(heartbeat|ping|pong|health|status|ok|ack)$/i.test(text)) return false;
    if (/^heartbeat[_\s]?(ok|check|ping|test)?$/i.test(text)) return false;
    // Skip the real heartbeat prompt (starts with "Read HEARTBEAT.md..." or mentions HEARTBEAT_OK)
    if (/heartbeat_ok/i.test(text) || /heartbeat\.md/i.test(text)) return false;
    return true;
  });
}

function formatTurnsForSummary(turns: ConversationTurn[]): string {
  const meaningful = filterMeaningfulTurns(turns);
  return meaningful
    .map((turn, i) => {
      const parts: string[] = [];
      if (turn.assistant) {
        parts.push(`  Assistant: ${turn.assistant}`);
      }
      parts.push(`  User: ${turn.user}`);
      return `${i + 1}.\n${parts.join("\n")}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a summary update should be triggered.
 *
 * We only start summarizing after enough turns have accumulated
 * (raw recent turns are sufficient for short conversations), AND
 * only when new turns have arrived since the last summary.
 */
export function shouldUpdateSummary(
  totalTurns: number,
  maxRecentTurns: number,
  updateInProgress: boolean,
  lastSummarizedTurnCount: number,
): boolean {
  if (updateInProgress) return false;
  // Only summarize when there are turns beyond the recent window
  if (totalTurns <= maxRecentTurns) return false;
  // Only re-summarize when new turns have arrived since last summary
  if (totalTurns <= lastSummarizedTurnCount) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

export type GenerateSummaryParams = {
  model: ResolvedGuardianModel;
  existingSummary: string | undefined;
  /** Turns to summarize (typically the older turns, not the recent raw ones). */
  turns: ConversationTurn[];
  timeoutMs: number;
  logger?: GuardianLogger;
};

/**
 * Generate or update a rolling conversation summary.
 *
 * Uses the guardian's LLM model via `callForText()`.
 * Returns the new summary text, or undefined on error.
 */
export async function generateSummary(params: GenerateSummaryParams): Promise<string | undefined> {
  const { model, existingSummary, turns, timeoutMs, logger } = params;

  if (turns.length === 0) return existingSummary;

  // Skip if all turns are trivial/system messages
  const meaningful = filterMeaningfulTurns(turns);
  if (meaningful.length === 0) return existingSummary;

  const userPrompt = existingSummary
    ? buildUpdateSummaryPrompt(existingSummary, turns)
    : buildInitialSummaryPrompt(turns);

  const callParams: TextCallParams = {
    model,
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userPrompt,
    timeoutMs,
    logger,
  };

  return callForText(callParams);
}

// Exported for testing
export const __testing = {
  SUMMARY_SYSTEM_PROMPT,
  buildInitialSummaryPrompt,
  buildUpdateSummaryPrompt,
  formatTurnsForSummary,
  filterMeaningfulTurns,
};
