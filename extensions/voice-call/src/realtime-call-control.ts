import {
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";

/** Stable provider-facing tool name for ending the current phone call. */
export const REALTIME_VOICE_END_CALL_TOOL_NAME = "openclaw_end_call";

/** Stable provider-facing tool name for passing over audio that was not meant for the assistant. */
export const REALTIME_VOICE_STAY_SILENT_TOOL_NAME = "openclaw_stay_silent";

/** Closure-bound end-call control exposed on every realtime phone call. */
const REALTIME_VOICE_END_CALL_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_END_CALL_TOOL_NAME,
  description:
    "End the current phone call immediately. Speak any final words to the caller before invoking this tool because the call ends as soon as it is invoked and no further reply will be spoken.",
  parameters: {
    type: "object",
    properties: {},
  },
};

/**
 * A realtime reply nearly always speaks. This gives the model a way to answer audio that was
 * not meant for it (a TV, other people in the room) with silence instead of "Sorry, how can I
 * help?".
 */
const REALTIME_VOICE_STAY_SILENT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_STAY_SILENT_TOOL_NAME,
  description:
    "Invoke this instead of speaking when what you just heard was not the caller talking to you: background voices, children, a TV or radio, music, noise, or sounds you cannot make out. Nothing is said to the caller, and you keep listening.",
  parameters: {
    type: "object",
    properties: {},
  },
};

/** Merge built-in call controls with consult and configured realtime tools. */
export function resolveVoiceCallRealtimeTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
  customTools: RealtimeVoiceTool[] = [],
  options: { staySilent?: boolean } = {},
): RealtimeVoiceTool[] {
  const builtIn = [
    REALTIME_VOICE_END_CALL_TOOL,
    ...(options.staySilent ? [REALTIME_VOICE_STAY_SILENT_TOOL] : []),
  ];
  const builtInNames = new Set(builtIn.map((tool) => tool.name));
  const tools = resolveRealtimeVoiceAgentConsultTools(policy, customTools).filter(
    (tool) => !builtInNames.has(tool.name),
  );
  return [...builtIn, ...tools];
}
