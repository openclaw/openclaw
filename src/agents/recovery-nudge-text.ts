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
// contain the runner's wording, and two separate matched runs are required
// because a single run can still fall out of a sentence about the previous
// turn. Wording shared by several nudges is boilerplate ("do not restart from
// scratch") and never on its own proof of a restatement, so it is not matched.
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
const RECOVERY_INSTRUCTION_ECHO_RUNS = buildRecoveryInstructionEchoRuns();

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

function readRecoveryInstructionEchoRuns(text: string): string[] {
  return spreadRecoveryInstructionRuns(normalizeRecoveryInstructionWords(text));
}

function buildRecoveryInstructionEchoRuns(): Set<string> {
  const nudgeCounts = new Map<string, number>();
  for (const text of RECOVERY_NUDGE_TEXTS) {
    for (const run of new Set(readRecoveryInstructionEchoRuns(text))) {
      nudgeCounts.set(run, (nudgeCounts.get(run) ?? 0) + 1);
    }
  }
  return new Set([...nudgeCounts].filter(([, nudges]) => nudges === 1).map(([run]) => run));
}

/**
 * Detects a reply that restates an injected recovery nudge. The runner knows the
 * exact wording it injected, so a reply that reproduces two distinct runs of it
 * is transport noise rather than an answer. Only the injected prompts match;
 * planning prose that never quotes them stays a genuine answer.
 */
export function isRecoveryInstructionEcho(text: string): boolean {
  const matches = new Set<string>();
  for (const run of spreadRecoveryInstructionRuns(normalizeRecoveryInstructionWords(text))) {
    if (RECOVERY_INSTRUCTION_ECHO_RUNS.has(run)) {
      matches.add(run);
      if (matches.size >= RECOVERY_INSTRUCTION_ECHO_MIN_MATCHES) {
        return true;
      }
    }
  }
  return false;
}
