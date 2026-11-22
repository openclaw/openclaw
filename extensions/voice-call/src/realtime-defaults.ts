import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_END_CALL_TOOL_NAME } from "./realtime-call-control.js";

const DEFAULT_VOICE_CALL_ROLE =
  "You are OpenClaw's phone-call realtime voice interface. Keep spoken replies brief and natural.";

/** Baseline instructions that keep realtime calls brief and route deep work to agent consult. */
export const DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS = `${DEFAULT_VOICE_CALL_ROLE} When a question needs deeper reasoning, current information, or tools, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} before answering. When the caller asks to end the call, speak any final words first, then call ${REALTIME_VOICE_END_CALL_TOOL_NAME}; it ends the call immediately and nothing after it will be spoken.`;

// Native-delegation models have no function tools; the realtime handler appends their hang-up guidance.
const NATIVE_DELEGATION_DEFAULT_INSTRUCTIONS = `${DEFAULT_VOICE_CALL_ROLE} When a question needs deeper reasoning, current information, or tools, delegate it to OpenClaw before answering.`;

/** Swaps the built-in default for wording without function-tool names on native-delegation models. */
export function resolveVoiceCallBaseInstructions(
  instructions: string,
  handlesAgentConsult: boolean,
): string {
  if (!handlesAgentConsult || !instructions.startsWith(DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS)) {
    return instructions;
  }
  return (
    NATIVE_DELEGATION_DEFAULT_INSTRUCTIONS +
    instructions.slice(DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS.length)
  );
}
