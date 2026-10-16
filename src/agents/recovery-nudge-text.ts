/**
 * Wording the runner injects when a turn has to be re-asked for its user-visible
 * answer. Each of these prompts is followed by a reply the runner publishes
 * verbatim, so each carries the same delivery contract, and each stays
 * recognizable here so a reply that restates one can be refused.
 *
 * This module is a dependency-free leaf: the plugin-SDK harness facade and the
 * harness result validator both import it, and neither may pull the runner's
 * policy graph in with it.
 */

/**
 * Delivery contract shared by every recovery nudge. Without it a reasoning
 * model can read the nudge as internal state and narrate its plan, or restate
 * the nudge itself, into the user-visible answer.
 */
export const RECOVERY_REPLY_DELIVERY_CONTRACT =
  "Your reply is delivered to the user verbatim: reply with only the answer, never with planning, status narration, or a restatement of these instructions.";

export const REASONING_ONLY_RETRY_BODY =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
export const EMPTY_RESPONSE_RETRY_BODY =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
export const TEXT_TOOL_CALL_RETRY_BODY =
  "You wrote a tool call as text, so nothing ran for that call. Continue from the current state and call the tool natively through the tool interface. Do not print tool-call JSON or markup as your answer.";
export const TOOL_USE_WITHOUT_CALL_RETRY_BODY =
  "The previous assistant turn stopped for tool use but contained no tool call, so nothing ran. Continue from the current state: call the tool you need through the tool interface instead of writing the call as text, or produce the visible answer now. Do not restart from scratch.";
export const REJECTED_TOOL_CALL_RETRY_BODY =
  "The previous assistant turn's tool call was rejected before it ran because the provider returned incomplete or malformed tool-call arguments, so nothing ran for that call. Continue from the current state: re-issue the call you need through the tool interface with complete, valid JSON arguments, or produce the visible answer now. Do not repeat completed tool calls or restart from scratch.";
export const SETTLED_TOOL_TERMINAL_CONTINUATION_BODY =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";
export const COMPACTION_CONTINUATION_RETRY_BODY =
  "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript and produce the final answer now. Do not restart from scratch, do not repeat completed work, and do not rerun tools unless the transcript clearly lacks required evidence.";
export const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_BODY =
  "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";

export function withRecoveryDeliveryContract(body: string): string {
  return `${body} ${RECOVERY_REPLY_DELIVERY_CONTRACT}`;
}

// Eight consecutive words are long enough that an ordinary answer will not
// contain the runner's wording. Two of them are required, and they must not
// overlap: overlapping windows of a single shared sentence collapse into one
// run, so a genuine answer that merely shares a phrase with a nudge survives.
const RECOVERY_INSTRUCTION_ECHO_RUN_WORDS = 8;
const RECOVERY_INSTRUCTION_ECHO_MIN_MATCHES = 2;
const RECOVERY_NUDGE_TEXTS = [
  REASONING_ONLY_RETRY_BODY,
  EMPTY_RESPONSE_RETRY_BODY,
  TEXT_TOOL_CALL_RETRY_BODY,
  TOOL_USE_WITHOUT_CALL_RETRY_BODY,
  REJECTED_TOOL_CALL_RETRY_BODY,
  SETTLED_TOOL_TERMINAL_CONTINUATION_BODY,
  COMPACTION_CONTINUATION_RETRY_BODY,
  BEFORE_AGENT_FINALIZE_RETRY_PROMPT_BODY,
  RECOVERY_REPLY_DELIVERY_CONTRACT,
];
const RECOVERY_INSTRUCTION_ECHO_RUNS = buildRecoveryInstructionEchoRuns(RECOVERY_NUDGE_TEXTS);

function normalizeRecoveryInstructionWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function spreadRecoveryInstructionRuns(words: string[]): string[] {
  const runs: string[] = [];
  for (let index = 0; index + RECOVERY_INSTRUCTION_ECHO_RUN_WORDS <= words.length; index += 1) {
    runs.push(words.slice(index, index + RECOVERY_INSTRUCTION_ECHO_RUN_WORDS).join(" "));
  }
  return runs;
}

function buildRecoveryInstructionEchoRuns(texts: readonly string[]): Set<string> {
  const nudgeCounts = new Map<string, number>();
  for (const text of texts) {
    for (const run of new Set(
      spreadRecoveryInstructionRuns(normalizeRecoveryInstructionWords(text)),
    )) {
      nudgeCounts.set(run, (nudgeCounts.get(run) ?? 0) + 1);
    }
  }
  // Wording shared by several nudges is boilerplate ("do not restart from
  // scratch") and never on its own proof of a restatement. With a single text
  // every run is unique to it, so nothing is filtered out.
  return new Set([...nudgeCounts].filter(([, nudges]) => nudges === 1).map(([run]) => run));
}

function countNonOverlappingEchoRuns(words: string[], runs: ReadonlySet<string>): number {
  let matches = 0;
  let coveredUntil = 0;
  for (let index = 0; index + RECOVERY_INSTRUCTION_ECHO_RUN_WORDS <= words.length; index += 1) {
    // Skip windows that overlap an already-accepted run so one shared passage
    // can never satisfy the match count on its own.
    if (index < coveredUntil) {
      continue;
    }
    const run = words.slice(index, index + RECOVERY_INSTRUCTION_ECHO_RUN_WORDS).join(" ");
    if (!runs.has(run)) {
      continue;
    }
    matches += 1;
    coveredUntil = index + RECOVERY_INSTRUCTION_ECHO_RUN_WORDS;
    if (matches >= RECOVERY_INSTRUCTION_ECHO_MIN_MATCHES) {
      return matches;
    }
  }
  return matches;
}

/**
 * Detects a reply that restates an injected recovery nudge. The runner knows the
 * exact wording it injected, so a reply that reproduces two separate runs of it
 * is transport noise rather than an answer.
 *
 * Pass the injected instruction whenever it is known: only that wording can
 * then count as an echo, so an answer quoting some other recovery prompt stays a
 * genuine answer. Without it every nudge is matched. Either way the two matched
 * runs must not overlap, so planning prose that reuses a single phrase is kept.
 */
export function isRecoveryInstructionEcho(text: string, instruction?: string): boolean {
  const runs =
    instruction && instruction.trim().length > 0
      ? buildRecoveryInstructionEchoRuns([instruction])
      : RECOVERY_INSTRUCTION_ECHO_RUNS;
  return (
    countNonOverlappingEchoRuns(normalizeRecoveryInstructionWords(text), runs) >=
    RECOVERY_INSTRUCTION_ECHO_MIN_MATCHES
  );
}
