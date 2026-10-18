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
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current state; do not restart from scratch.";
export const REQUIRED_RESULT_RETRY_BODY =
  "Your turn ended without a final result. Continue from the current state and produce the required result now. NO_REPLY is not allowed. Do not restart from scratch.";
export const TEXT_TOOL_CALL_RETRY_BODY =
  "You wrote a tool call as text, so nothing ran for that call. Continue from the current state and call the tool natively through the tool interface. Do not print tool-call JSON or markup as your answer.";
export const TOOL_USE_WITHOUT_CALL_RETRY_BODY =
  "The previous assistant turn stopped for tool use but contained no tool call, so nothing ran. Continue from the current state: call the tool you need through the tool interface instead of writing the call as text, or produce the visible answer now. Do not restart from scratch.";
export const REJECTED_TOOL_CALL_RETRY_BODY =
  "The previous assistant turn's tool call was rejected before it ran because the provider returned incomplete or malformed tool-call arguments, so nothing ran for that call. Continue from the current state: re-issue the call you need through the tool interface with complete, valid JSON arguments, or produce the visible answer now. Do not repeat completed tool calls or restart from scratch.";
export const SETTLED_TOOL_TERMINAL_CONTINUATION_BODY =
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current transcript. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";
export const REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_BODY =
  "Your turn ended without a final result. Continue from the current transcript and produce the required result now. NO_REPLY is not allowed. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";
export const COMPACTION_CONTINUATION_RETRY_BODY =
  "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript and produce the final answer now. Do not restart from scratch, do not repeat completed work, and do not rerun tools unless the transcript clearly lacks required evidence.";
export const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_BODY =
  "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";

export function withRecoveryDeliveryContract(body: string): string {
  return `${body} ${RECOVERY_REPLY_DELIVERY_CONTRACT}`;
}

export const COMPACTION_CONTINUATION_RETRY_INSTRUCTION = withRecoveryDeliveryContract(
  COMPACTION_CONTINUATION_RETRY_BODY,
);
export const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX = withRecoveryDeliveryContract(
  BEFORE_AGENT_FINALIZE_RETRY_PROMPT_BODY,
);

// A restatement repeats the instruction that was actually injected. Small
// framing around it ("Let me plan this out…") is still an echo, but a genuine
// answer that quotes one sentence or fragment of the instruction is not.
const RECOVERY_INSTRUCTION_ECHO_MAX_FRAMING_WORDS = 12;
const RECOVERY_NUDGE_BODIES = [
  REASONING_ONLY_RETRY_BODY,
  EMPTY_RESPONSE_RETRY_BODY,
  REQUIRED_RESULT_RETRY_BODY,
  TEXT_TOOL_CALL_RETRY_BODY,
  TOOL_USE_WITHOUT_CALL_RETRY_BODY,
  REJECTED_TOOL_CALL_RETRY_BODY,
  SETTLED_TOOL_TERMINAL_CONTINUATION_BODY,
  REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_BODY,
  COMPACTION_CONTINUATION_RETRY_BODY,
  BEFORE_AGENT_FINALIZE_RETRY_PROMPT_BODY,
];
const RECOVERY_NUDGE_TEXTS = [
  ...RECOVERY_NUDGE_BODIES,
  ...RECOVERY_NUDGE_BODIES.map(withRecoveryDeliveryContract),
  RECOVERY_REPLY_DELIVERY_CONTRACT,
];
function normalizeRecoveryInstructionWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const RECOVERY_NUDGE_WORDS = RECOVERY_NUDGE_TEXTS.map(normalizeRecoveryInstructionWords);

function findInstructionWords(words: string[], instruction: string[]): number {
  for (let index = 0; index + instruction.length <= words.length; index += 1) {
    if (instruction.every((word, offset) => words[index + offset] === word)) {
      return index;
    }
  }
  return -1;
}

function repeatsInjectedInstruction(words: string[], instruction: string[]): boolean {
  if (instruction.length === 0) {
    return false;
  }
  let remaining = words;
  let removed = 0;
  for (;;) {
    const index = findInstructionWords(remaining, instruction);
    if (index < 0) {
      break;
    }
    remaining = [...remaining.slice(0, index), ...remaining.slice(index + instruction.length)];
    removed += instruction.length;
  }
  return removed > 0 && remaining.length <= RECOVERY_INSTRUCTION_ECHO_MAX_FRAMING_WORDS;
}

/**
 * Detects a reply that restates an injected recovery nudge. The runner knows the
 * exact wording it injected, so only a reply that reproduces the complete
 * instruction (with at most a short amount of framing) is transport noise.
 *
 * Pass the injected instruction whenever it is known: only that wording can
 * then count as an echo, so an answer quoting some other recovery prompt stays a
 * genuine answer. Without it every nudge is matched. Quoting one sentence or a
 * shorter fragment keeps the answer substantive.
 */
export function isRecoveryInstructionEcho(text: string, instruction?: string): boolean {
  const words = normalizeRecoveryInstructionWords(text);
  if (words.length === 0) {
    return false;
  }
  const instructions =
    instruction && instruction.trim().length > 0
      ? [normalizeRecoveryInstructionWords(instruction)]
      : RECOVERY_NUDGE_WORDS;
  return instructions.some((candidate) => repeatsInjectedInstruction(words, candidate));
}
