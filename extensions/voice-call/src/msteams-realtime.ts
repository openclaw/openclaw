/**
 * Microsoft Teams realtime voice bridge.
 *
 * When `realtime.enabled` is set for the msteams provider, a Teams call is wired
 * directly to a speech-to-speech realtime model (e.g. OpenAI / Azure OpenAI
 * Realtime) instead of the STT -> agent -> TTS pipeline. This is the low-latency
 * path: the model listens, thinks, and speaks in one streaming session.
 *
 * Audio crosses the existing msteams WebSocket as PCM 16 kHz, 16-bit mono. The
 * realtime model speaks PCM 16-bit mono at 24 kHz, so we resample on both legs:
 *   caller  16 kHz -> 24 kHz -> model
 *   model   24 kHz -> 16 kHz -> caller
 * The Windows worker reframes the downlink PCM into 20 ms / 640-byte frames, so
 * we can forward arbitrary-length chunks as a single `audio.frame`.
 *
 * The model owns conversation/VAD/turn-taking and answers small talk directly.
 * For anything that needs work (lookups, actions, tools) it calls
 * `openclaw_agent_consult`, which runs the full OpenClaw agent and returns a
 * speakable result; a short "working on it" filler covers longer agent runs.
 */

import { readFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultTranscriptEntry,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps } from "./core-bridge.js";
import { inferEmotion } from "./expression.js";
import type { GroupCallGateConfig } from "./group-call-gate.js";
import {
  MSTEAMS_PCM_SAMPLE_RATE_HZ,
  type MsteamsLogger,
  type MsteamsSession,
} from "./msteams-media-stream.js";
import { describeMsteamsVideoFrameOwner, type MsteamsVideoFrame } from "./msteams-video-frame.js";
import { resolveRealtimeFastContextConsult } from "./realtime-fast-context.js";
import { resolveVoiceResponseModel } from "./response-model.js";
import { readArgText } from "./utils.js";
import type { VisionBudget } from "./vision-budget.js";

/** Teams bridge wire format. */
const MSTEAMS_SAMPLE_RATE_HZ = MSTEAMS_PCM_SAMPLE_RATE_HZ;
/** OpenAI/Azure realtime PCM format. */
const REALTIME_SAMPLE_RATE_HZ = 24_000;
/** Cap the consult transcript context so it cannot grow without bound on long calls. */
const MAX_TRANSCRIPT_ENTRIES = 40;

/**
 * CVI Phase 4 — how often to push the latest inbound frame into the realtime session as ambient
 * visual context. Only fires when the frame changed and the vision budget allows, so a static screen
 * costs nothing; on a changing screen the budget (`maxVisionPerMinute`) is the real cap.
 */
const REALTIME_VISION_PUSH_INTERVAL_MS = 6000;

const MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent receiving delegated requests from a live Microsoft Teams voice call.",
  "Act on behalf of the caller using the normal available tools when the caller asks you to do work.",
  "Prioritize completing the caller's request and returning a fast, speakable result over exhaustive investigation.",
  "Do not print secret values or dump environment variables; only check whether required configuration is present.",
  "Be accurate, brief, and speakable.",
].join(" ");

const MSTEAMS_REALTIME_LOOK_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent looking at a still frame captured from a live Microsoft Teams call —",
  "the caller's shared screen or camera. Answer the caller's question about what is visible.",
  "Read on-screen text verbatim when asked. Be concise and speakable (1-2 sentences);",
  "if the image is unclear or the thing asked about is not visible, say so briefly.",
].join(" ");

/** Tool the realtime model calls to hand a long-running task to the background agent. */
const MSTEAMS_AGENT_TASK_TOOL_NAME = "openclaw_agent_task";
const MSTEAMS_AGENT_TASK_TOOL: RealtimeVoiceTool = {
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
const MSTEAMS_LOOK_TOOL_NAME = "look_at_screen";
const MSTEAMS_LOOK_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: MSTEAMS_LOOK_TOOL_NAME,
  description:
    "Look at what the caller is currently showing on the Teams call — their shared screen or " +
    "camera — and answer a question about it. Use this whenever the caller refers to something " +
    'visual ("what\'s on my screen?", "read this error", "what am I holding?"). ' +
    "Defaults to the screen-share when present, otherwise the camera.",
  parameters: {
    type: "object",
    properties: {
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

const MSTEAMS_SHOW_TOOL_NAME = "show_to_caller";
const MSTEAMS_SHOW_TOOL: RealtimeVoiceTool = {
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
const MSTEAMS_REALTIME_SHOW_SYSTEM_PROMPT =
  "The caller is on a live video call and asked to SEE something. Produce exactly ONE image to show " +
  "them — take a screenshot of your screen (use the browser to open a page first if needed), or " +
  "generate/fetch the requested image — using your tools. Your ONLY job is to PRODUCE the image file; " +
  "the call displays it on your video tile automatically. Do NOT try to present or display it yourself " +
  "(no canvas, no connected node) and do NOT send it as a chat message. Return a brief spoken sentence " +
  "describing what you're showing.";

/** Max bytes for an agent-produced image we'll display (safety bound). */
const MSTEAMS_MAX_DISPLAY_IMAGE_BYTES = 4_000_000;

/** show_to_caller produces an image (browse + screenshot / generate), which needs more than the
 *  quick-reply budget; the model plays a "working on it" filler while it runs. */
const MSTEAMS_SHOW_TIMEOUT_MS = 90_000;

/** MIME for an image by file/URL extension (query string stripped), or null for non-images. */
function mimeForImageExtension(pathOrUrl: string): string | null {
  const ext = (pathOrUrl.split(/[?#]/)[0] ?? "").toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/** Returned when look_at_screen is over the per-call vision budget (cost cap). */
const MSTEAMS_LOOK_BUDGETED = {
  text: "I've been looking quite a lot in the last minute — give me a few seconds and ask again.",
};

/** Returned when the caller asks the agent to look but no video frame has arrived yet. */
const MSTEAMS_LOOK_NO_FRAME = {
  text: "I can't see anything yet — make sure your camera or screen-share is on. It can take a few seconds after you start sharing; then ask again.",
};

/** Spoken acknowledgement returned to the model when a background task is accepted. */
const MSTEAMS_ASYNC_TASK_ACK = {
  text: "Got it — I'm on it and I'll message you on Microsoft Teams when it's done.",
};

/** Acknowledgement when the caller asked to be called back (deliverVia: "call"). */
const MSTEAMS_ASYNC_TASK_ACK_CALL = {
  text: "Got it — I'm on it and I'll call you back on Microsoft Teams when it's done.",
};

/**
 * Returned to the model when a background task is requested but the caller has no
 * AAD object id — there is no Teams chat to deliver the result to, so the task is
 * refused rather than acknowledging a delivery that cannot happen. The model
 * should offer to answer on the call instead.
 */
const MSTEAMS_ASYNC_TASK_NO_TARGET = {
  text: "I can't run that in the background — I don't have a Teams chat to send the result to. I can work on it right now on the call instead.",
};

/**
 * Returned to the model when the agent is asked to act but recording is not yet
 * active. The agent must not process/persist call audio before Graph
 * `updateRecordingStatus` (Media Access API), so consult + task are refused.
 */
const MSTEAMS_RECORDING_BLOCKED = {
  text: "I can't act on that yet — call recording isn't active. Please make sure recording is on and ask again.",
};

/**
 * Append the group-call gate as a model instruction. The realtime bridge owns turn-taking and
 * exposes no response-suppression hook, so the gate is enforced by telling the model to stay silent
 * in a meeting until addressed by name. Inert when the gate is off or has no wake phrases.
 */
function withGroupGateInstruction(
  instructions: string | undefined,
  gate: GroupCallGateConfig | undefined,
): string | undefined {
  const phrases = gate?.wakePhrases?.filter((p) => p.trim().length > 0) ?? [];
  if (!gate?.requireAddress || phrases.length === 0) {
    return instructions;
  }
  const names = phrases.map((p) => `"${p}"`).join(", ");
  const clause = [
    "GROUP-CALL ETIQUETTE: If more than one person is on this call (a group meeting), do NOT reply",
    `unless someone addresses you by name (${names}) or clearly directs a question to you. When you`,
    "are not addressed, stay silent and just listen — do not narrate, acknowledge, or interject.",
    "Once addressed, you may continue a short back-and-forth until the topic moves on. In a",
    "one-on-one call (only you and one person), respond normally to everything.",
  ].join(" ");
  return instructions ? `${instructions}\n\n${clause}` : clause;
}

export interface MsteamsRealtimeDeps {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg?: OpenClawConfig;
  /** System instructions for the realtime model. */
  instructions?: string;
  /** Instruction used to open the call (model speaks first). Empty/undefined = silent join. */
  greetingInstructions?: string;
  /** Realtime tools exposed to the model (e.g. openclaw_agent_consult). */
  tools?: RealtimeVoiceTool[];
  /** Inbound-call policy applied before bridging (mirrors the streaming path). */
  inboundPolicy?: "disabled" | "allowlist" | "pairing" | "open";
  /** Allowlist of caller ids honored when inboundPolicy is "allowlist"/"pairing". */
  allowFrom?: string[];
  /**
   * Require active Teams recording status before the agent may process or persist
   * call audio (the consult tool and the background task). Default true. Mirrors
   * the streaming path's `msteams.requireRecordingStatus` (Media Access API).
   */
  requireRecordingStatus?: boolean;

  // --- openclaw_agent_consult wiring (the agent actually does the work) ---
  /** Host agent runtime used to run the OpenClaw agent behind the consult tool. */
  agentRuntime?: CoreAgentDeps;
  /** Full voice config (for agentId, realtime.{toolPolicy,fastContext,consult*}, responseTimeoutMs). */
  voiceConfig?: VoiceCallConfig;
  /** Consult tool policy; controls which agent tools the consult run may use. */
  toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
  /**
   * Latest sampled inbound video frame (camera / screen-share) for the `look_at_screen` tool, so
   * the agent can describe what the caller is showing. Provided by the provider; undefined disables
   * the tool. Uses the shared `MsteamsVideoFrame` type (type-only import → no runtime cycle).
   */
  getLatestFrame?: (source?: "camera" | "screenshare") => MsteamsVideoFrame | undefined;

  /**
   * Suppress caller-leg input while assistant audio is playing (self-echo guard).
   * OFF by default: Teams delivers remote-participant audio (not our own playback),
   * and gating input would also defeat the model's barge-in detection.
   */
  suppressInputDuringPlayback?: boolean;

  /**
   * Group-call gate. The realtime model owns turn-taking, so (unlike the deterministic streaming
   * gate) this is applied as an instruction: in a meeting the model is told to stay silent until
   * addressed by name. Undefined / requireAddress=false ⇒ respond normally.
   */
  groupCallGate?: GroupCallGateConfig;

  /** Per-call vision spend cap shared across calls (look_at_screen). Undefined = unlimited. */
  visionBudget?: VisionBudget;

  logger?: MsteamsLogger;
}

/** A single Teams call bridged to the realtime model. */
export interface MsteamsRealtimeCall {
  /** Forward one inbound PCM 16 kHz frame from the caller into the model. */
  pushAudio(pcm16k: Buffer): void;
  /** Update Teams recording status (gates the consult tool + background task). */
  setRecordingActive(active: boolean): void;
  /**
   * Tear down the realtime session. Pass a `reason` for a manager-driven hangup (idle timeout, notify
   * auto-hangup, explicit endCall) to ALSO close the Teams worker session so the call actually ends;
   * omit it for a caller-driven `session.end` (the session is already closing).
   */
  close(reason?: string): void;
}

/**
 * Create and connect a realtime bridge for one Teams call. Inbound caller audio
 * is fed via {@link MsteamsRealtimeCall.pushAudio}; model audio is sent back over
 * the provided {@link MsteamsSession} as `audio.frame` messages, and barge-in is
 * surfaced as `assistant.cancel` so the worker flushes its playback queue.
 */
export function createMsteamsRealtimeCall(params: {
  session: MsteamsSession;
  deps: MsteamsRealtimeDeps;
}): MsteamsRealtimeCall {
  const { session, deps } = params;
  const { logger } = deps;
  const callId = session.callId;
  // Realtime subagent memory key honors the voice-call `sessionScope` (matching the streaming path):
  // "per-phone" (default) keys by the caller's Teams AAD id so the same caller's memory carries across
  // calls; "per-call" keys by callId. An anonymous caller (no aadId) falls back to per-call so distinct
  // anonymous callers never collide into one session.
  const sessionScopeId =
    deps.voiceConfig?.sessionScope === "per-call" ? callId : (session.caller.aadId ?? callId);

  let outboundSeq = 0;
  let outboundTimestampMs = 0;
  let turnId = 0;
  let closed = false;
  /** Last time we sent assistant audio to the caller (self-echo gate). */
  let lastOutputAt = 0;
  /**
   * Teams recording status. Gates the consult tool + background task so the agent
   * never processes or persists call audio before Graph `updateRecordingStatus`
   * is active (Media Access API). Seeded from `session.start`, updated by
   * `recording.status` via {@link MsteamsRealtimeCall.setRecordingActive}.
   */
  let recordingActive = session.recordingStatus === "active";
  /** Whether the recording-status gate is enforced (default true). */
  const requireRecordingStatus = deps.requireRecordingStatus !== false;
  /** True when the agent must NOT process/persist call audio yet. */
  const recordingGateBlocks = (): boolean => requireRecordingStatus && !recordingActive;

  /** Rolling consult context built from the model's final transcripts. */
  const transcript: RealtimeVoiceAgentConsultTranscriptEntry[] = [];

  /**
   * Vision rate-limit: cache the last look_at_screen answer keyed by the exact frame bytes, so
   * repeated "what's on my screen?" on an unchanged frame returns instantly without re-running the
   * (expensive) vision agent. A new frame (changed screen) misses the cache and re-runs.
   */
  let lastLookData: string | undefined;
  let lastLookText: string | undefined;

  /** Phase 4 proactive vision: the last frame bytes pushed into the session (skip unchanged), + timer. */
  let lastPushedFrameData: string | undefined;
  let visionPushTimer: ReturnType<typeof setInterval> | undefined;
  /** Phase 6b: last emotion cued to the worker, so we only send on change (early + self-correcting). */
  let lastSentExpression: string | undefined;

  function recordTranscript(role: "user" | "assistant", text: string): void {
    // Media Access API: never retain media-derived transcript text before Teams
    // recording status is active. Otherwise pre-recording turns would sit in the
    // buffer and be sent to the agent once consult/task run after recording flips
    // active. Dropping here keeps the consult context recording-active-only.
    if (recordingGateBlocks()) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    // Coalesce consecutive fragments from the same speaker so one spoken turn is
    // a single context entry (avoids feeding the agent half-sentences).
    const last = transcript.at(-1);
    if (last && last.role === role) {
      last.text = `${last.text} ${trimmed}`.trim();
    } else {
      transcript.push({ role, text: trimmed });
    }
    if (transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  }

  const consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy =
    deps.toolPolicy ?? deps.voiceConfig?.realtime.toolPolicy ?? "none";
  // Async background tasks deliver their result via the agent's `message` tool,
  // which is only available under the "owner" tool policy.
  const asyncTasksEnabled =
    Boolean(deps.agentRuntime && deps.voiceConfig && deps.cfg) && consultToolPolicy === "owner";
  // Vision: expose the look_at_screen tool when the agent runtime + a frame source are available
  // AND the tool policy permits tools at all — read-only vision is off under "none", on under
  // "safe-read-only" and "owner". (The ambient frame push is independent continuous-vision context.)
  const visionEnabled =
    Boolean(deps.agentRuntime && deps.voiceConfig && deps.cfg && deps.getLatestFrame) &&
    consultToolPolicy !== "none";
  // show_to_caller produces its own image via owner-level tools (screenshot / browser / image-gen),
  // so it is exposed ONLY under the "owner" policy — never under "none" or "safe-read-only".
  const showEnabled =
    Boolean(deps.agentRuntime && deps.voiceConfig && deps.cfg) && consultToolPolicy === "owner";
  const bridgeTools = [
    ...(deps.tools ?? []),
    ...(asyncTasksEnabled ? [MSTEAMS_AGENT_TASK_TOOL] : []),
    ...(visionEnabled ? [MSTEAMS_LOOK_TOOL] : []),
    ...(showEnabled ? [MSTEAMS_SHOW_TOOL] : []),
  ];

  /**
   * Shared consult invocation for the consult / look_at_screen / background-task handlers: resolves
   * the agent model + thinking level and calls consultRealtimeVoiceAgent with the common Teams
   * params. Each handler supplies only what differs (run id, args, surface, prompt, tool policy, and
   * optional images / fastMode / timeout). agentId + sessionKey are passed in because the consult
   * handler also uses them for its fast-context path.
   */
  const runMsteamsConsult = (opts: {
    agentRuntime: CoreAgentDeps;
    voiceConfig: VoiceCallConfig;
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    runIdPrefix: string;
    args: unknown;
    surface: string;
    extraSystemPrompt: string;
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    fastMode?: boolean;
    timeoutMs?: number;
    trustLocalMedia?: boolean;
  }) => {
    const { provider: agentProvider, model } = resolveVoiceResponseModel({
      voiceConfig: opts.voiceConfig,
      agentRuntime: opts.agentRuntime,
    });
    const thinkLevel =
      opts.voiceConfig.realtime.consultThinkingLevel ??
      opts.agentRuntime.resolveThinkingDefault({ cfg: opts.cfg, provider: agentProvider, model });
    return consultRealtimeVoiceAgent({
      cfg: opts.cfg,
      agentRuntime: opts.agentRuntime,
      logger: { warn: (message) => logger?.warn(message) },
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: opts.runIdPrefix,
      args: opts.args,
      ...(opts.images ? { images: opts.images } : {}),
      transcript: [...transcript],
      surface: opts.surface,
      userLabel: "Caller",
      assistantLabel: "Agent",
      questionSourceLabel: "caller",
      provider: agentProvider,
      model,
      thinkLevel,
      fastMode: opts.fastMode ?? opts.voiceConfig.realtime.consultFastMode,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.trustLocalMedia ? { trustLocalMedia: true } : {}),
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(opts.toolPolicy),
      extraSystemPrompt: opts.extraSystemPrompt,
    });
  };

  const realtime = createRealtimeVoiceBridgeSession({
    provider: deps.provider,
    cfg: deps.cfg,
    providerConfig: deps.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: withGroupGateInstruction(deps.instructions, deps.groupCallGate),
    initialGreetingInstructions: deps.greetingInstructions,
    triggerGreetingOnReady: Boolean(deps.greetingInstructions),
    autoRespondToAudio: true,
    interruptResponseOnInputAudio: true,
    tools: bridgeTools,
    audioSink: {
      isOpen: () => !closed,
      sendAudio: (pcm24k: Buffer) => {
        if (closed || pcm24k.length === 0) {
          return;
        }
        lastOutputAt = Date.now();
        const pcm16k = resamplePcm(pcm24k, REALTIME_SAMPLE_RATE_HZ, MSTEAMS_SAMPLE_RATE_HZ);
        session.send({
          type: "audio.frame",
          seq: outboundSeq,
          timestampMs: outboundTimestampMs,
          payloadBase64: pcm16k.toString("base64"),
        });
        outboundSeq += 1;
        // 16-bit mono: 2 bytes/sample.
        outboundTimestampMs += Math.round((pcm16k.length / 2 / MSTEAMS_SAMPLE_RATE_HZ) * 1000);
      },
      clearAudio: () => {
        // Barge-in: the model truncated its turn — tell the worker to flush the
        // audio it has already queued for playback so the caller isn't talked over.
        turnId += 1;
        session.send({ type: "assistant.cancel", turnId });
      },
    },
    onTranscript: (role, text, isFinal) => {
      // CVI Phase 6b: cue emotion as EARLY as possible — on the FIRST assistant transcript chunk of a
      // turn (partial or final), not only the final — so the face isn't neutral while a happy/sad reply
      // is already being spoken. De-duped on the inferred emotion so unchanged cues aren't spammed, and
      // it self-corrects if later text shifts the emotion (e.g. "sorry … but that's great!").
      if (role === "assistant" && !closed) {
        const emotion = inferEmotion(text);
        if (emotion !== lastSentExpression) {
          lastSentExpression = emotion;
          logger?.debug?.(`MsteamsRealtime: expression cue '${emotion}' for ${callId}`);
          try {
            session.send({ type: "expression", emotion });
          } catch {
            // non-fatal
          }
        }
      }
      if (isFinal) {
        recordTranscript(role, text);
      }
    },
    onToolCall: (event, rtSession) => {
      if (event.name === MSTEAMS_AGENT_TASK_TOOL_NAME) {
        handleAsyncTask(event, rtSession);
        return;
      }
      if (event.name === MSTEAMS_LOOK_TOOL_NAME) {
        void handleLook(event, rtSession);
        return;
      }
      if (event.name === MSTEAMS_SHOW_TOOL_NAME) {
        void handleShow(event, rtSession);
        return;
      }
      void handleToolCall(event, rtSession);
    },
    onError: (error) => {
      logger?.warn(`MsteamsRealtime: bridge error — ${error.message}`);
    },
    onClose: () => {
      closed = true;
      if (visionPushTimer) {
        clearInterval(visionPushTimer);
        visionPushTimer = undefined;
      }
    },
  });

  /**
   * CVI Phase 4: push the latest inbound frame into the realtime session as ambient context so the
   * model is continuously visually aware — not only when the caller invokes `look_at_screen`. Skips
   * when nothing changed, before recording is active, or when over the vision budget. No forced
   * response: the model uses the frame on its next natural turn.
   */
  function pushLatestFrameToModel(): void {
    if (closed || recordingGateBlocks() || !deps.getLatestFrame) {
      return;
    }
    const frame = deps.getLatestFrame();
    if (!frame || frame.dataBase64 === lastPushedFrameData) {
      return; // no frame yet, or unchanged since the last push
    }
    if (deps.visionBudget && !deps.visionBudget.tryConsume(callId, Date.now())) {
      return; // over the per-call vision budget
    }
    lastPushedFrameData = frame.dataBase64;
    logger?.debug?.(`MsteamsRealtime: ambient vision push (${frame.source}) for ${callId}`);
    try {
      const owner = describeMsteamsVideoFrameOwner(frame);
      realtime.sendImage({
        dataBase64: frame.dataBase64,
        mime: frame.mime,
        text: owner ? `Live view — ${owner}.` : "Live view of the call.",
      });
    } catch (err) {
      logger?.debug?.(
        `MsteamsRealtime: vision push failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (deps.getLatestFrame) {
    visionPushTimer = setInterval(pushLatestFrameToModel, REALTIME_VISION_PUSH_INTERVAL_MS);
    // Don't keep the process alive for this cosmetic-awareness timer.
    visionPushTimer.unref?.();
  }

  /** Run the OpenClaw agent for an openclaw_agent_consult call and speak the result. */
  async function handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    rtSession: RealtimeVoiceBridgeSession,
  ): Promise<void> {
    if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      return;
    }
    // Media Access API: refuse to run the agent on call audio until recording is active.
    if (recordingGateBlocks()) {
      logger?.debug?.(`MsteamsRealtime: consult refused for ${callId} — recording not active`);
      rtSession.submitToolResult(event.callId, MSTEAMS_RECORDING_BLOCKED);
      return;
    }
    const { agentRuntime, voiceConfig, cfg } = deps;
    if (!agentRuntime || !voiceConfig || !cfg) {
      rtSession.submitToolResult(event.callId, {
        text: "The assistant agent is not available right now.",
      });
      return;
    }

    const agentId = voiceConfig.agentId ?? "main";
    const sessionKey = `agent:${agentId}:subagent:msteams:${sessionScopeId}`;
    const toolPolicy = deps.toolPolicy ?? voiceConfig.realtime.toolPolicy;

    try {
      // Fast path: answer from memory/session context without a full agent run.
      const fastContext = await resolveRealtimeFastContextConsult({
        cfg,
        agentId,
        sessionKey,
        config: voiceConfig.realtime.fastContext,
        args: event.args,
        logger: { debug: (message) => logger?.debug?.(message) },
      });
      if (fastContext.handled) {
        rtSession.submitToolResult(event.callId, fastContext.result);
        return;
      }

      // Slower path: a full agent run. Emit a "working on it" filler first (if the
      // provider supports tool-result continuation) so the caller is not left in
      // silence while the agent works.
      if (rtSession.bridge?.supportsToolResultContinuation) {
        rtSession.submitToolResult(
          event.callId,
          buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
          { willContinue: true },
        );
      }

      const result = await runMsteamsConsult({
        agentRuntime,
        voiceConfig,
        cfg,
        agentId,
        sessionKey,
        runIdPrefix: `voice-realtime-consult:${callId}`,
        args: event.args,
        surface: "a live Microsoft Teams call",
        extraSystemPrompt: MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT,
        toolPolicy,
        timeoutMs: voiceConfig.responseTimeoutMs,
      });
      rtSession.submitToolResult(event.callId, result);
    } catch (err) {
      logger?.warn(
        `MsteamsRealtime: consult failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      rtSession.submitToolResult(event.callId, {
        text: "Sorry, I ran into a problem while working on that.",
      });
    }
  }

  /** Run a vision-capable agent over the latest inbound video frame and speak the answer. */
  async function handleLook(
    event: RealtimeVoiceToolCallEvent,
    rtSession: RealtimeVoiceBridgeSession,
  ): Promise<void> {
    // Media Access API: do not process call video before recording is active.
    if (recordingGateBlocks()) {
      logger?.debug?.(`MsteamsRealtime: look refused for ${callId} — recording not active`);
      rtSession.submitToolResult(event.callId, MSTEAMS_RECORDING_BLOCKED);
      return;
    }
    const { agentRuntime, voiceConfig, cfg } = deps;
    if (!agentRuntime || !voiceConfig || !cfg || !deps.getLatestFrame) {
      rtSession.submitToolResult(event.callId, {
        text: "The assistant can't look at video right now.",
      });
      return;
    }

    const sourceArg = readArgText(event.args, "source");
    const source = sourceArg === "camera" || sourceArg === "screenshare" ? sourceArg : undefined;
    const frame = deps.getLatestFrame(source);
    if (!frame) {
      rtSession.submitToolResult(event.callId, MSTEAMS_LOOK_NO_FRAME);
      return;
    }

    // Rate-limit: the same frame was already described → return the cached answer without a re-run.
    if (lastLookData === frame.dataBase64 && lastLookText) {
      logger?.debug?.(`MsteamsRealtime: look cache hit for ${callId} (unchanged frame)`);
      rtSession.submitToolResult(event.callId, { text: lastLookText });
      return;
    }

    // Cost cap: a changed frame means a fresh (expensive) vision run — gate it on the vision budget.
    if (deps.visionBudget && !deps.visionBudget.tryConsume(callId, Date.now())) {
      logger?.debug?.(`MsteamsRealtime: look over vision budget for ${callId}`);
      rtSession.submitToolResult(event.callId, MSTEAMS_LOOK_BUDGETED);
      return;
    }

    const agentId = voiceConfig.agentId ?? "main";
    const sessionKey = `agent:${agentId}:subagent:msteams:${sessionScopeId}`;
    const toolPolicy = deps.toolPolicy ?? voiceConfig.realtime.toolPolicy;

    try {
      // Speak a short filler while the vision run completes (if the provider supports it).
      if (rtSession.bridge?.supportsToolResultContinuation) {
        rtSession.submitToolResult(
          event.callId,
          buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
          { willContinue: true },
        );
      }

      const result = await runMsteamsConsult({
        agentRuntime,
        voiceConfig,
        cfg,
        agentId,
        sessionKey,
        runIdPrefix: `voice-realtime-look:${callId}`,
        args: event.args,
        images: [{ type: "image", data: frame.dataBase64, mimeType: frame.mime }],
        surface: (() => {
          const owner = describeMsteamsVideoFrameOwner(frame);
          return owner
            ? `a live Microsoft Teams call — the attached image is ${owner}`
            : "a live Microsoft Teams call (a participant is sharing video)";
        })(),
        extraSystemPrompt: MSTEAMS_REALTIME_LOOK_SYSTEM_PROMPT,
        toolPolicy,
        timeoutMs: voiceConfig.responseTimeoutMs,
      });
      lastLookData = frame.dataBase64;
      lastLookText = result.text;
      rtSession.submitToolResult(event.callId, result);
    } catch (err) {
      logger?.warn(
        `MsteamsRealtime: look failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      rtSession.submitToolResult(event.callId, { text: "Sorry, I had trouble seeing that." });
    }
  }

  /** Load an agent-produced image — a local file (readFile) or a remote URL (SSRF-guarded fetch). */
  async function loadDisplayImage(
    pathOrUrl: string,
  ): Promise<{ bytes: Buffer; mime: string } | null> {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      // Remote URL (e.g. an uploaded screenshot). Public hosts only; the guard blocks private/loopback.
      try {
        const { response, release } = await fetchWithSsrFGuard({
          url: pathOrUrl,
          init: { method: "GET" },
          policy: {},
          timeoutMs: 15_000,
        });
        try {
          if (!response.ok) {
            return null;
          }
          const contentType =
            (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
          const mime = contentType.startsWith("image/")
            ? contentType
            : mimeForImageExtension(pathOrUrl);
          if (!mime) {
            return null;
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length === 0 || bytes.length > MSTEAMS_MAX_DISPLAY_IMAGE_BYTES) {
            return null;
          }
          return { bytes, mime };
        } finally {
          void release?.();
        }
      } catch {
        return null;
      }
    }
    // Local file produced by the agent's own tool run.
    const mime = mimeForImageExtension(pathOrUrl);
    if (!mime) {
      return null;
    }
    try {
      const bytes = await readFile(pathOrUrl);
      if (bytes.length === 0 || bytes.length > MSTEAMS_MAX_DISPLAY_IMAGE_BYTES) {
        return null;
      }
      return { bytes, mime };
    } catch {
      return null;
    }
  }

  /** Show agent-produced images (local files or remote URLs) on the outbound tile (Phase 8). */
  async function forwardDisplayImages(mediaPaths: string[]): Promise<number> {
    let shown = 0;
    for (const pathOrUrl of mediaPaths) {
      const img = await loadDisplayImage(pathOrUrl);
      if (!img) {
        logger?.debug?.(
          `MsteamsRealtime: skipped non-displayable media ${pathOrUrl} for ${callId}`,
        );
        continue;
      }
      try {
        logger?.debug?.(
          `MsteamsRealtime: display.image (${img.mime}, ${img.bytes.length}B) for ${callId}`,
        );
        session.send({
          type: "display.image",
          dataBase64: img.bytes.toString("base64"),
          mime: img.mime,
        });
        shown += 1;
      } catch (err) {
        logger?.debug?.(
          `MsteamsRealtime: display.image send failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return shown;
  }

  /**
   * show_to_caller (CVI Phase 8): run the agent to PRODUCE an image (screenshot / generated image) and
   * display it on the bot's video tile. Reuses the consult path; the produced trusted-local media is
   * read and sent as `display.image`. The agent is told not to also message it to chat.
   */
  async function handleShow(
    event: RealtimeVoiceToolCallEvent,
    rtSession: RealtimeVoiceBridgeSession,
  ): Promise<void> {
    if (recordingGateBlocks()) {
      logger?.debug?.(`MsteamsRealtime: show refused for ${callId} — recording not active`);
      rtSession.submitToolResult(event.callId, MSTEAMS_RECORDING_BLOCKED);
      return;
    }
    const { agentRuntime, voiceConfig, cfg } = deps;
    if (!agentRuntime || !voiceConfig || !cfg) {
      rtSession.submitToolResult(event.callId, { text: "I can't show images on this call." });
      return;
    }
    const agentId = voiceConfig.agentId ?? "main";
    const sessionKey = `agent:${agentId}:subagent:msteams:${sessionScopeId}`;
    try {
      if (rtSession.bridge?.supportsToolResultContinuation) {
        rtSession.submitToolResult(
          event.callId,
          buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
          { willContinue: true },
        );
      }
      // show_to_caller sends { request }; the consult contract expects question/prompt/query/task,
      // so map request -> question (otherwise the consult throws "question required").
      const showRequest =
        event.args &&
        typeof event.args === "object" &&
        typeof (event.args as { request?: unknown }).request === "string"
          ? (event.args as { request: string }).request
          : undefined;
      const result = await runMsteamsConsult({
        agentRuntime,
        voiceConfig,
        cfg,
        agentId,
        sessionKey,
        runIdPrefix: `voice-realtime-show:${callId}`,
        args: showRequest ? { question: showRequest } : event.args,
        surface:
          "a live Microsoft Teams video call — show the caller an image on the bot's video tile",
        extraSystemPrompt: MSTEAMS_REALTIME_SHOW_SYSTEM_PROMPT,
        toolPolicy: "owner", // needs the screenshot / image-generation tools
        timeoutMs: Math.max(voiceConfig.responseTimeoutMs, MSTEAMS_SHOW_TIMEOUT_MS),
        // show is a controlled, single-image production run — trust the local image it produces
        // (general consults leave this false, so an arbitrary local path is never displayed).
        trustLocalMedia: true,
      });
      const shown = await forwardDisplayImages(result.mediaPaths ?? []);
      rtSession.submitToolResult(event.callId, {
        text:
          shown > 0
            ? result.text || "I'm showing it on your screen now."
            : result.text || "Sorry, I couldn't produce an image to show.",
      });
    } catch (err) {
      logger?.warn(
        `MsteamsRealtime: show failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      rtSession.submitToolResult(event.callId, { text: "Sorry, I had trouble showing that." });
    }
  }

  /**
   * A long task: acknowledge on the call immediately, then run the OpenClaw agent
   * in the background. The call can end while it works; the agent delivers the
   * result to the caller's Teams chat via the `message` tool when done.
   */
  function handleAsyncTask(
    event: RealtimeVoiceToolCallEvent,
    rtSession: RealtimeVoiceBridgeSession,
  ): void {
    // Media Access API: a background task processes + persists call audio and
    // delivers it to Teams chat, so it must not start before recording is active.
    if (recordingGateBlocks()) {
      logger?.debug?.(`MsteamsRealtime: task refused for ${callId} — recording not active`);
      rtSession.submitToolResult(event.callId, MSTEAMS_RECORDING_BLOCKED);
      return;
    }
    // A background task's only delivery channel is the caller's Teams chat
    // (message tool -> user:<aadId>). Without an aadId there is nowhere to
    // deliver, so refuse the task instead of acking a delivery we can't fulfill
    // and silently dropping the result.
    if (!session.caller.aadId) {
      logger?.warn(`MsteamsRealtime: task refused for ${callId} — no caller.aadId delivery target`);
      rtSession.submitToolResult(event.callId, MSTEAMS_ASYNC_TASK_NO_TARGET);
      return;
    }
    const task = readArgText(event.args, "task") ?? readArgText(event.args, "question");
    const deliverVia = readArgText(event.args, "deliverVia") === "call" ? "call" : "message";
    // Ack immediately so the model speaks the "I'll reach you" line and the call
    // is free to continue or hang up.
    rtSession.submitToolResult(
      event.callId,
      deliverVia === "call" ? MSTEAMS_ASYNC_TASK_ACK_CALL : MSTEAMS_ASYNC_TASK_ACK,
    );
    if (!task) {
      return;
    }
    // Detached: not awaited and not cancelled on call teardown.
    void runAsyncTask(task, deliverVia);
  }

  async function runAsyncTask(task: string, deliverVia: "message" | "call"): Promise<void> {
    const { agentRuntime, voiceConfig, cfg } = deps;
    if (!agentRuntime || !voiceConfig || !cfg) {
      return;
    }
    const aadId = session.caller.aadId ?? undefined;
    const deliveryTarget = aadId ? `user:${aadId}` : undefined;
    const agentId = voiceConfig.agentId ?? "main";
    const sessionKey = `agent:${agentId}:subagent:msteams:${sessionScopeId}`;

    const deliveryInstruction = !deliveryTarget
      ? "This task was delegated from a Microsoft Teams voice call and runs in the background; deliver the final result to the caller when complete."
      : deliverVia === "call"
        ? `This task was delegated from a live Microsoft Teams voice call and now runs in the background; the caller is no longer on the line. FIRST actually complete the task and determine the final answer. THEN deliver it by invoking the voice_call tool exactly once: action "initiate_call", to "${deliveryTarget}", mode "notify". CRITICAL: the caller hears ONLY your "message" and has NO memory of what they asked — so "message" must be a COMPLETE, STANDALONE spoken result that both restates the topic AND gives the answer in one breath. Good: "Here's the Dubai time you asked for — it's 5:41 PM." Bad (do NOT do this): a greeting, a question, "I'm calling about your request", "let me check", an empty/placeholder value, or a bare answer with no context. If you genuinely could not determine the answer, set "message" to a clear one-sentence explanation of what went wrong instead. Place the call exactly once.`
        : `This task was delegated from a live Microsoft Teams voice call and now runs in the background; the caller is no longer waiting on the line. Complete the task, then deliver the final result to the caller by calling the message tool exactly once with action "send", channel "msteams", target "${deliveryTarget}". Keep the delivered message concise.`;

    try {
      await runMsteamsConsult({
        agentRuntime,
        voiceConfig,
        cfg,
        agentId,
        sessionKey,
        runIdPrefix: `voice-realtime-task:${callId}`,
        args: { question: task },
        surface: "a Microsoft Teams voice call (background task)",
        extraSystemPrompt: `${MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT} ${deliveryInstruction}`,
        toolPolicy: consultToolPolicy,
        fastMode: false,
      });
      logger?.debug?.(`MsteamsRealtime: background task complete for ${callId}`);
    } catch (err) {
      logger?.warn(
        `MsteamsRealtime: background task failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  void realtime.connect().catch((err: unknown) => {
    logger?.error(
      `MsteamsRealtime: connect failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    // The model never came up; close the Teams session so the worker hangs up
    // cleanly instead of leaving the caller in silence.
    closed = true;
    try {
      session.close("realtime-unavailable");
    } catch {
      // best-effort teardown
    }
  });

  return {
    pushAudio: (pcm16k: Buffer) => {
      if (closed || pcm16k.length === 0) {
        return;
      }
      // Recording gate: do not forward caller audio to the realtime provider until the
      // call's recording status is active (Microsoft Media Access API obligation, matching
      // the streaming path and every other media-derived path here). No-op when
      // requireRecordingStatus is false.
      if (recordingGateBlocks()) {
        return;
      }
      // Optional self-echo guard: drop caller-leg audio that arrives within a short
      // window of our own playback. OFF by default (would also suppress barge-in).
      if (deps.suppressInputDuringPlayback && Date.now() - lastOutputAt < 200) {
        return;
      }
      const pcm24k = resamplePcm(pcm16k, MSTEAMS_SAMPLE_RATE_HZ, REALTIME_SAMPLE_RATE_HZ);
      realtime.sendAudio(pcm24k);
    },
    setRecordingActive: (active: boolean) => {
      recordingActive = active;
    },
    close: (reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      if (visionPushTimer) {
        clearInterval(visionPushTimer);
        visionPushTimer = undefined;
      }
      try {
        realtime.close();
      } catch {
        // best-effort teardown
      }
      // A manager-driven hangup passes a reason — also close the Teams worker session so the call
      // actually ends. A caller-driven session.end passes none (the session is already closing).
      if (reason !== undefined) {
        try {
          session.close(reason);
        } catch {
          // best-effort teardown
        }
      }
    },
  };
}
