import type { MockScenarioState, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_TOOL_REPEAT_RECOVERY_PROMPT_RE = /tool repeat recovery qa check/i;
const QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE = /global tool loop breaker qa check/i;

/** Scripts a model stuck on one identical read for the tool repeat guard scenarios. */
export function resolveToolRepeatTurn(params: {
  text: string;
  toolOutput: string;
  hasToolOutput: boolean;
  exactReply?: string;
  state: MockScenarioState;
  read: (path: string) => StreamEvent[];
}): StreamEvent[] | undefined {
  if (QA_TOOL_REPEAT_RECOVERY_PROMPT_RE.test(params.text)) {
    // Obeys the redirect note; repeats the same failing read until it arrives.
    return /same arguments 3 times in a row/i.test(params.toolOutput)
      ? buildAssistantEvents(params.exactReply ?? "TOOL-REPEAT-RECOVERED-OK")
      : params.read("LOOP_MISSING.txt");
  }
  if (!QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE.test(params.text)) {
    return undefined;
  }
  // Ignores every note and keeps reading until the runtime ends the turn.
  params.state.toolLoopReadAttempts = params.hasToolOutput
    ? params.state.toolLoopReadAttempts + 1
    : 1;
  return params.state.toolLoopReadAttempts > 25
    ? buildAssistantEvents("GLOBAL-LOOP-BREAKER-NOT-REACHED")
    : params.read("LOOP_STEADY.txt");
}
