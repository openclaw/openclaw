/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";
import type { SessionEntry } from "../api.js";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";

export type VoiceResponseParams = {
  /** Voice call config */
  voiceConfig: VoiceCallConfig;
  /** Core OpenClaw config */
  coreConfig: CoreConfig;
  /** Injected host agent runtime */
  agentRuntime: CoreAgentDeps;
  /** Call ID for session tracking */
  callId: string;
  /** Caller's phone number */
  from: string;
  /** Conversation transcript */
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  /** Latest user message */
  userMessage: string;
};

export type VoiceResponseResult = {
  text: string | null;
  error?: string;
  endCall?: boolean;
};

type VoiceResponsePayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
};

const VOICE_SPOKEN_OUTPUT_CONTRACT = [
  "Output format requirements:",
  '- Return only valid JSON in this exact shape: {"spoken":"..."}',
  "- Do not include markdown, code fences, planning text, or extra keys.",
  '- Put exactly what should be spoken to the caller into "spoken".',
  '- If there is nothing to say, return {"spoken":""}.',
].join("\n");

function normalizeSpokenText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveModelPrimary(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const primary = (raw as { primary?: unknown }).primary;
  if (typeof primary !== "string") {
    return undefined;
  }
  const trimmed = primary.trim();
  return trimmed || undefined;
}

function resolveVoiceAgentPrimaryModel(
  coreConfig: CoreConfig,
  agentId: string,
): string | undefined {
  const agents =
    (coreConfig?.agents as { defaults?: { model?: unknown }; list?: unknown } | undefined) ??
    undefined;
  const entries = Array.isArray(agents?.list) ? agents.list : [];
  const normalizedAgentId = agentId.trim().toLowerCase();
  const selectedAgent = entries.find((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.trim().toLowerCase() === normalizedAgentId;
  }) as { model?: unknown } | undefined;

  return resolveModelPrimary(selectedAgent?.model) ?? resolveModelPrimary(agents?.defaults?.model);
}

function tryParseSpokenJson(text: string): string | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  candidates.push(trimmed);

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { spoken?: unknown };
      if (typeof parsed?.spoken !== "string") {
        continue;
      }
      return normalizeSpokenText(parsed.spoken) ?? "";
    } catch {
      // Continue trying other candidates.
    }
  }

  const inlineSpokenMatch = trimmed.match(/"spoken"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (!inlineSpokenMatch) {
    return null;
  }

  try {
    const decoded = JSON.parse(`"${inlineSpokenMatch[1] ?? ""}"`) as string;
    return normalizeSpokenText(decoded) ?? "";
  } catch {
    return null;
  }
}

function isLikelyMetaReasoningParagraph(paragraph: string): boolean {
  const lower = paragraph.toLowerCase();
  if (!lower) {
    return false;
  }

  if (lower.startsWith("thinking process")) {
    return true;
  }
  if (lower.startsWith("reasoning:") || lower.startsWith("analysis:")) {
    return true;
  }
  if (
    lower.startsWith("the user ") &&
    (lower.includes("i should") || lower.includes("i need to") || lower.includes("i will"))
  ) {
    return true;
  }
  if (
    lower.includes("this is a natural continuation of the conversation") ||
    lower.includes("keep the conversation flowing")
  ) {
    return true;
  }

  return false;
}

function sanitizePlainSpokenText(text: string): string | null {
  const withoutCodeFences = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutCodeFences) {
    return null;
  }

  const paragraphs = withoutCodeFences
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  while (paragraphs.length > 1 && isLikelyMetaReasoningParagraph(paragraphs[0])) {
    paragraphs.shift();
  }

  return normalizeSpokenText(paragraphs.join(" "));
}

function extractSpokenTextFromPayloads(payloads: VoiceResponsePayload[]): string | null {
  const spokenSegments: string[] = [];

  for (const payload of payloads) {
    if (payload.isError || payload.isReasoning) {
      continue;
    }

    const rawText = payload.text?.trim() ?? "";
    if (!rawText) {
      continue;
    }

    const structured = tryParseSpokenJson(rawText);
    if (structured !== null) {
      if (structured.length > 0) {
        spokenSegments.push(structured);
      }
      continue;
    }

    const plain = sanitizePlainSpokenText(rawText);
    if (plain) {
      spokenSegments.push(plain);
    }
  }

  return spokenSegments.length > 0 ? spokenSegments.join(" ").trim() : null;
}

/**
 * Generate a voice response using the embedded Pi agent with full tool support.
 * Uses the same agent infrastructure as messaging for consistent behavior.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const { voiceConfig, callId, from, transcript, userMessage, coreConfig, agentRuntime } = params;

  if (!coreConfig) {
    return { text: null, error: "Core config unavailable for voice response" };
  }
  const cfg = coreConfig;

  // Build voice-specific session key based on phone number
  const normalizedPhone = from.replace(/\D/g, "");
  const sessionKey = `voice:${normalizedPhone}`;
  const agentId = voiceConfig.responseAgent || "main";

  // Resolve paths
  const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  // Load or create session entry
  const sessionStore = agentRuntime.session.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

  if (!sessionEntry) {
    sessionEntry = {
      sessionId: crypto.randomUUID(),
      updatedAt: now,
    };
    sessionStore[sessionKey] = sessionEntry;
    await agentRuntime.session.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  // Resolve model from config.
  // Prefer explicit voice responseModel, then the selected response agent's model,
  // then the global agent default, then runtime defaults.
  const modelRef =
    voiceConfig.responseModel ||
    resolveVoiceAgentPrimaryModel(coreConfig, agentId) ||
    `${agentRuntime.defaults.provider}/${agentRuntime.defaults.model}`;
  const slashIndex = modelRef.indexOf("/");
  const provider =
    slashIndex === -1 ? agentRuntime.defaults.provider : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  // Resolve thinking level
  const thinkLevel = agentRuntime.resolveThinkingDefault({ cfg, provider, model });

  // Resolve agent identity for personalized prompt
  const identity = agentRuntime.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  // Build system prompt with conversation history
  const basePrompt =
    voiceConfig.responseSystemPrompt ??
    `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.

IMPORTANT: Your responses will be read aloud by a text-to-speech engine. Write everything as it should be spoken:
- Numbers: "13 degrees Celsius" not "13°C", "5 percent" not "5%"
- Times: "2 thirty PM" not "14:30" or "2:30 PM"
- Dates: "February 5th" not "2026-02-05"
- URLs/paths: skip or describe them, don't read raw URLs
- Abbreviations: spell out or use spoken form
- No markdown, bullet points, or special formatting

When the conversation is naturally over or the caller says goodbye, say a brief farewell and end your response with the exact tag [END_CALL]. This signals the system to hang up the phone after your farewell is spoken.`;

  let extraSystemPrompt = basePrompt;
  if (transcript.length > 0) {
    const history = transcript
      .map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`)
      .join("\n");
    extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${history}`;
  }
  extraSystemPrompt = `${extraSystemPrompt}\n\n${VOICE_SPOKEN_OUTPUT_CONTRACT}`;

  // Resolve timeout
  const timeoutMs = voiceConfig.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;

  try {
    let endCallRequested = false;

    const result = await agentRuntime.runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "voice",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: userMessage,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId,
      lane: "voice",
      extraSystemPrompt,
      agentDir,
    });

    let text = extractSpokenTextFromPayloads((result.payloads ?? []) as VoiceResponsePayload[]);

    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    // Check for [END_CALL] marker and strip it from spoken text
    if (text && text.includes("[END_CALL]")) {
      endCallRequested = true;
      text = text.replace(/\s*\[END_CALL\]\s*/g, "").trim() || null;
    }

    return { text, endCall: endCallRequested };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
