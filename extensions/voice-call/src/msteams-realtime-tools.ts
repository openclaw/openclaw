/**
 * The msteams realtime bridge's tool surface: the realtime-tool definitions the model sees
 * (background task / look_at_screen / show_to_caller / post_meeting_minutes), the system prompts
 * for their consult runs, and the canned spoken results (refusals / acks). Pure declarations — the
 * handlers live in msteams-realtime.ts. Split out so the bridge file holds behavior, not ~200
 * lines of declarative surface.
 */

import type { RealtimeVoiceTool } from "openclaw/plugin-sdk/realtime-voice";

export const MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent receiving delegated requests from a live Microsoft Teams voice call.",
  "Act on behalf of the caller using the normal available tools when the caller asks you to do work.",
  "Prioritize completing the caller's request and returning a fast, speakable result over exhaustive investigation.",
  "Do not print secret values or dump environment variables; only check whether required configuration is present.",
  "Be accurate, brief, and speakable.",
].join(" ");

export const MSTEAMS_REALTIME_LOOK_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent looking at a still frame captured from a live Microsoft Teams call —",
  "the caller's shared screen or camera. Answer the caller's question about what is visible.",
  "Read on-screen text verbatim when asked. Be concise and speakable (1-2 sentences);",
  "if the image is unclear or the thing asked about is not visible, say so briefly.",
].join(" ");

/** Tool the realtime model calls to hand a long-running task to the background agent. */
export const MSTEAMS_AGENT_TASK_TOOL_NAME = "openclaw_agent_task";
export const MSTEAMS_AGENT_TASK_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: MSTEAMS_AGENT_TASK_TOOL_NAME,
  description:
    "Hand a long-running task to the OpenClaw agent to complete in the background. " +
    "Use this for work that may take more than a few seconds (multi-step actions, lengthy research). " +
    "After calling it, tell the caller you are on it and will reach them on Microsoft Teams when it is done. " +
    "Do NOT use this for quick questions or lookups — use openclaw_agent_consult and answer in-line for those. " +
    'Do NOT use this when the caller wants to SEE an image on the call right now (e.g. "show me ...", ' +
    '"take a screenshot and show me") — use show_to_caller for that, even if it must open a browser or screenshot first. ' +
    'Set deliverVia to "call" when the caller asked to be CALLED back when done; otherwise it defaults to a Teams chat message.',
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "The task to perform, described in full so the background agent can complete it unattended.",
      },
      deliverVia: {
        type: "string",
        enum: ["message", "call"],
        description:
          'How to deliver the result: "message" (default) sends a Teams chat message; "call" places a Teams call back to the caller and speaks the result.',
      },
    },
    required: ["task"],
  },
};

/** Tool the realtime model calls to "see" what the caller is showing (camera / screen-share). */
export const MSTEAMS_LOOK_TOOL_NAME = "look_at_screen";
export const MSTEAMS_LOOK_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: MSTEAMS_LOOK_TOOL_NAME,
  description:
    "Look at what the caller is currently showing on the Teams call — their shared screen or " +
    "camera — and answer a question about it. Use this whenever the caller refers to something " +
    'visual ("what\'s on my screen?", "read this error", "what am I holding?"). ' +
    "Defaults to the screen-share when present, otherwise the camera. " +
    'Set scope to "history" when the caller asks about something shown EARLIER in the call ' +
    '("what did the previous slide say?", "catch me up on what was shown") — you then see the ' +
    "recent scene-change keyframes instead of only the live frame.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["live", "history"],
        description:
          '"live" (default) looks at the current frame; "history" reviews keyframes from earlier in the call.',
      },
      question: {
        type: "string",
        description: "What the caller wants to know about what they are showing.",
      },
      source: {
        type: "string",
        enum: ["screenshare", "camera"],
        description: "Which video to look at; defaults to screen-share, then camera.",
      },
    },
    required: ["question"],
  },
};

/** Tool: post minutes of the call so far to Teams chat, on request ("/summarize" by voice). */
export const MSTEAMS_MINUTES_TOOL_NAME = "post_meeting_minutes";
export const MSTEAMS_MINUTES_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: MSTEAMS_MINUTES_TOOL_NAME,
  description:
    "Post written minutes of this call SO FAR (key points, decisions, action items) to the Teams " +
    'chat. Use when the caller asks to "summarize the meeting", "post the minutes", or "send a ' +
    'recap". Tell the caller the minutes are on their way; do not dictate them aloud.',
  parameters: { type: "object", properties: {} },
};

export const MSTEAMS_SHOW_TOOL_NAME = "show_to_caller";
export const MSTEAMS_SHOW_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: MSTEAMS_SHOW_TOOL_NAME,
  description:
    "Show the caller an image on the video call — take a screenshot of your screen, or display an " +
    'image you generated or found. Use this when the caller asks to SEE something ("show me your ' +
    'screen", "show me that picture", "can I see it?", "show me the GitHub page"). The image appears ' +
    "on your video tile for a few seconds; describe what you are showing in your spoken reply. " +
    "This is the ONLY way to put an image on the call — use it even when producing the image first " +
    "needs you to open a browser, take a screenshot, or generate it. Do NOT hand this to a background " +
    "task and do NOT try to present it via canvas/a node; this tool displays it on the tile for you.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description:
          "What to show the caller, e.g. 'a screenshot of your screen' or 'the chart you generated'.",
      },
    },
    required: ["request"],
  },
};

/** System prompt for the show_to_caller consult: produce ONE image; the bridge displays it on the tile. */
export const MSTEAMS_REALTIME_SHOW_SYSTEM_PROMPT =
  "The caller is on a live video call and asked to SEE something. Produce exactly ONE image to show " +
  "them — take a screenshot of your screen, or generate/fetch the requested image — using your tools. " +
  "If the image is a web page, you MUST START the browser FIRST (open/start it, then navigate to the " +
  "URL) BEFORE taking a screenshot — do not assume a browser is already running. Your ONLY job is to " +
  "PRODUCE the image file; the call displays it on your video tile automatically. Do NOT try to present " +
  "or display it yourself (no canvas, no connected node) and do NOT send it as a chat message. Return a " +
  "brief spoken sentence describing what you're showing. If a tool fails (e.g. the browser cannot be " +
  "started or a profile is attach-only), return ONE plain spoken sentence stating exactly what went " +
  'wrong (e.g. "I couldn\'t start the browser") — never reply with a generic "I can\'t share".';

/** Returned when look_at_screen is over the per-call vision budget (cost cap). */
export const MSTEAMS_LOOK_BUDGETED = {
  text: "I've been looking quite a lot in the last minute — give me a few seconds and ask again.",
};

/** Returned when the caller asks the agent to look but no video frame has arrived yet. */
export const MSTEAMS_LOOK_NO_FRAME = {
  text: "I can't see anything yet — make sure your camera or screen-share is on. It can take a few seconds after you start sharing; then ask again.",
};

/** Spoken acknowledgement returned to the model when a background task is accepted. */
export const MSTEAMS_ASYNC_TASK_ACK = {
  text: "Got it — I'm on it and I'll message you on Microsoft Teams when it's done.",
};

/** Acknowledgement when the caller asked to be called back (deliverVia: "call"). */
export const MSTEAMS_ASYNC_TASK_ACK_CALL = {
  text: "Got it — I'm on it and I'll call you back on Microsoft Teams when it's done.",
};

/**
 * Returned to the model when a background task is requested but the caller has no
 * AAD object id — there is no Teams chat to deliver the result to, so the task is
 * refused rather than acknowledging a delivery that cannot happen. The model
 * should offer to answer on the call instead.
 */
export const MSTEAMS_ASYNC_TASK_NO_TARGET = {
  text: "I can't run that in the background — I don't have a Teams chat to send the result to. I can work on it right now on the call instead.",
};

/**
 * Returned to the model when the agent is asked to act but recording is not yet
 * active. The agent must not process/persist call audio before Graph
 * `updateRecordingStatus` (Media Access API), so consult + task are refused.
 */
export const MSTEAMS_RECORDING_BLOCKED = {
  text: "I can't act on that yet — call recording isn't active. Please make sure recording is on and ask again.",
};
