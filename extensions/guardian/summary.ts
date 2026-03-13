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

// ---------------------------------------------------------------------------
// Standing instructions extraction
// ---------------------------------------------------------------------------

const INSTRUCTIONS_SYSTEM_PROMPT = `You extract standing instructions from an AI assistant's system prompt.

Standing instructions are rules, preferences, or workflows the USER has configured that tell the assistant what to do automatically. Examples:
- "Always copy reports to Google Drive"
- "Send daily summaries to #general channel"
- "Use make build for deployments"
- "Never modify production database"
- "Run tests before committing"

Focus ONLY on user-configured rules that affect what ACTIONS the assistant should take.

Do NOT include:
- Safety rules or system-level restrictions
- Tool descriptions or API documentation
- Formatting/style guidelines
- Runtime/environment information
- The assistant's identity or persona

Output a concise bullet list of standing instructions (one per line, starting with "- ").
If no standing instructions are found, output exactly: NONE`;

/** Max chars of system prompt to send to the extraction LLM. */
const MAX_SYSTEM_PROMPT_FOR_EXTRACTION = 15_000;

function buildInstructionsExtractionPrompt(systemPrompt: string): string {
  const truncated =
    systemPrompt.length > MAX_SYSTEM_PROMPT_FOR_EXTRACTION
      ? systemPrompt.slice(0, MAX_SYSTEM_PROMPT_FOR_EXTRACTION) + "\n...(truncated)"
      : systemPrompt;

  return `Extract the user's standing instructions from this system prompt:\n\n${truncated}`;
}

export type ExtractInstructionsParams = {
  model: ResolvedGuardianModel;
  systemPrompt: string;
  timeoutMs: number;
  logger?: GuardianLogger;
};

/**
 * Extract standing instructions from the main agent's system prompt.
 *
 * Called once per session (on first `llm_input`). Uses the guardian's
 * LLM to distill the large system prompt into a concise bullet list
 * of user-configured rules/preferences.
 *
 * Returns the extracted instructions text, or undefined on error/empty.
 */
export async function extractStandingInstructions(
  params: ExtractInstructionsParams,
): Promise<string | undefined> {
  const { model, systemPrompt, timeoutMs, logger } = params;

  if (!systemPrompt || systemPrompt.trim().length === 0) return undefined;

  const userPrompt = buildInstructionsExtractionPrompt(systemPrompt);

  const callParams: TextCallParams = {
    model,
    systemPrompt: INSTRUCTIONS_SYSTEM_PROMPT,
    userPrompt,
    timeoutMs,
    logger,
  };

  const result = await callForText(callParams);
  if (!result || result.trim().toUpperCase() === "NONE") return undefined;
  return result.trim();
}

// ---------------------------------------------------------------------------
// Available skills extraction (regex-based, no LLM call)
// ---------------------------------------------------------------------------

/**
 * Extract a compact list of available skills from the agent's system prompt.
 *
 * The system prompt contains an `<available_skills>` XML block with skill
 * names and descriptions. We parse this directly — no LLM needed.
 *
 * Returns a formatted string like:
 *   - deploy: Deploy the project to production
 *   - review-pr: Review a pull request
 *
 * Or undefined if no skills section is found.
 */
export function extractAvailableSkills(systemPrompt: string): string | undefined {
  if (!systemPrompt) return undefined;

  // Match the <available_skills>...</available_skills> block
  const skillsBlockMatch = systemPrompt.match(/<available_skills>([\s\S]*?)<\/available_skills>/i);
  if (!skillsBlockMatch) return undefined;

  const skillsBlock = skillsBlockMatch[1];

  // Extract individual skill entries: <skill name="x"><description>y</description></skill>
  // or <skill><name>x</name><description>y</description></skill>
  const skills: string[] = [];

  // Pattern 1: <skill name="..."><description>...</description></skill>
  const namedPattern =
    /<skill[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<description>([\s\S]*?)<\/description>/gi;
  let match: RegExpExecArray | null;
  while ((match = namedPattern.exec(skillsBlock)) !== null) {
    const name = match[1].trim();
    const desc = match[2].trim().split("\n")[0].trim(); // first line only
    skills.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
  }

  // Pattern 2: <skill><name>x</name>...<description>y</description></skill>
  if (skills.length === 0) {
    const skillBlockPattern = /<skill[^>]*>([\s\S]*?)<\/skill>/gi;
    while ((match = skillBlockPattern.exec(skillsBlock)) !== null) {
      const inner = match[1];
      const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/i);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();
      const descMatch = inner.match(/<description>([\s\S]*?)<\/description>/i);
      const desc = descMatch?.[1]?.trim().split("\n")[0].trim();
      skills.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
    }
  }

  if (skills.length === 0) return undefined;
  return skills.join("\n");
}

// Exported for testing
export const __testing = {
  SUMMARY_SYSTEM_PROMPT,
  INSTRUCTIONS_SYSTEM_PROMPT,
  buildInitialSummaryPrompt,
  buildUpdateSummaryPrompt,
  buildInstructionsExtractionPrompt,
  formatTurnsForSummary,
  filterMeaningfulTurns,
  MAX_SYSTEM_PROMPT_FOR_EXTRACTION,
  extractAvailableSkills,
};
