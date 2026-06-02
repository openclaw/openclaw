import crypto from "node:crypto";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveVoiceCallSessionKey, type VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { resolveVoiceResponseModel } from "./response-model.js";

export type VoiceResponseParams = {
  /** Voice-call route config that selects agent, model, timeout, and session scope. */
  voiceConfig: VoiceCallConfig;
  /** Core OpenClaw config used by the embedded agent runtime and session store. */
  coreConfig: CoreConfig;
  /** Injected host agent runtime used to create/reuse the voice response session. */
  agentRuntime: CoreAgentDeps;
  /** Internal call id used for per-call session keys and run ids. */
  callId: string;
  /** Persisted call session key from the call record, when already resolved. */
  sessionKey?: string;
  /** Caller's phone number, used for phone-scoped fallback session keys and prompts. */
  from: string;
  /** Durable conversation transcript included in the system prompt as call history. */
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  /** Latest caller utterance sent as the embedded-agent prompt. */
  userMessage: string;
};

export type VoiceResponseResult = {
  /** Spoken text extracted from the agent payloads, or null for silence/failure. */
  text: string | null;
  /** User-safe failure summary when the embedded response could not be produced. */
  error?: string;
};

type VoiceResponsePayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
};

function readExplicitToolsAllow(value: unknown): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const allow = value.allow;
  if (!Array.isArray(allow)) {
    return undefined;
  }

  return allow.filter((entry): entry is string => typeof entry === "string");
}

function resolveVoiceAgentToolsAllow(config: CoreConfig, agentId: string): string[] | undefined {
  const agents = isRecord(config.agents) ? config.agents : undefined;
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const agent = list.find((entry) => isRecord(entry) && entry.id === agentId);
  if (!isRecord(agent)) {
    return undefined;
  }

  return readExplicitToolsAllow(isRecord(agent.tools) ? agent.tools : undefined);
}

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

/** Recovers the required spoken JSON object even when the model wraps it in fences or prose. */
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
    // Models sometimes wrap the required JSON in prose; recover the outer object
    // before falling back to plain-text sanitization.
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
  const lower = normalizeLowercaseStringOrEmpty(paragraph);
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

/** Drops obvious planning text while preserving conversational fallback output for the caller. */
function sanitizePlainSpokenText(text: string): string | null {
  const withoutCodeFences = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutCodeFences) {
    return null;
  }

  const paragraphs = normalizeStringEntries(withoutCodeFences.split(/\n\s*\n+/));

  // Keep conversational plain text usable, but drop obvious planning paragraphs
  // that should never be spoken to the caller.
  while (paragraphs.length > 1 && isLikelyMetaReasoningParagraph(paragraphs[0])) {
    paragraphs.shift();
  }

  return normalizeSpokenText(paragraphs.join(" "));
}

/** Extracts only caller-safe speech segments from mixed agent text, reasoning, and error payloads. */
function extractSpokenTextFromPayloads(payloads: VoiceResponsePayload[]): string | null {
  const spokenSegments: string[] = [];

  for (const payload of payloads) {
    // Voice payloads can interleave hidden reasoning/tool errors with user-facing
    // text; only speak explicit non-error output.
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

/** Scopes voice sessions into agent sandboxes so phone/call keys cannot collide across agents. */
function resolveVoiceSandboxSessionKey(agentId: string, sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  // Embedded agents expect an agent-scoped sandbox key even when the persisted
  // voice session key is phone- or call-scoped.
  return `agent:${agentId}:${trimmed}`;
}

/**
 * Generates a spoken voice response through the embedded OpenClaw agent runtime.
 * The agent is forced through a JSON spoken-output contract, but this helper
 * also sanitizes common plain-text fallback output before returning speech.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const {
    voiceConfig,
    callId,
    sessionKey,
    from,
    transcript,
    userMessage,
    coreConfig,
    agentRuntime,
  } = params;

  if (!coreConfig) {
    return { text: null, error: "Core config unavailable for voice response" };
  }
  const cfg = coreConfig;

  const resolvedSessionKey = resolveVoiceCallSessionKey({
    config: voiceConfig,
    callId,
    phone: from,
    explicitSessionKey: sessionKey,
  });
  const agentId = voiceConfig.agentId ?? "main";
  const toolsAllow = resolveVoiceAgentToolsAllow(cfg, agentId);

  const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);

  await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  const now = Date.now();
  const existingSessionEntry = agentRuntime.session.getSessionEntry({
    storePath,
    sessionKey: resolvedSessionKey,
  });

  const { provider, model } = resolveVoiceResponseModel({ voiceConfig, agentRuntime });

  let sessionEntry = existingSessionEntry;
  if (!sessionEntry?.sessionId || voiceConfig.responseModel) {
    // Response-model overrides are pinned on the session before the embedded
    // agent starts so inherited model/auth metadata cannot leak from old calls.
    sessionEntry =
      (await agentRuntime.session.patchSessionEntry({
        storePath,
        sessionKey: resolvedSessionKey,
        replaceEntry: true,
        fallbackEntry: sessionEntry ?? {
          sessionId: crypto.randomUUID(),
          updatedAt: now,
        },
        update: (entry) => {
          const next = entry.sessionId
            ? { ...entry }
            : {
                ...entry,
                sessionId: crypto.randomUUID(),
                updatedAt: now,
              };
          if (voiceConfig.responseModel) {
            applyModelOverrideToSessionEntry({
              entry: next,
              selection: { provider, model },
              selectionSource: "auto",
            });
          }
          return next;
        },
      })) ?? undefined;
  }
  if (!sessionEntry?.sessionId) {
    return { text: null, error: "Voice response session could not be initialized" };
  }
  const sessionId = sessionEntry.sessionId;

  const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  const thinkLevel = agentRuntime.resolveThinkingDefault({ cfg, provider, model });

  const identity = agentRuntime.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  const basePrompt =
    voiceConfig.responseSystemPrompt ??
    `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;

  let extraSystemPrompt = basePrompt;
  if (transcript.length > 0) {
    const history = transcript
      .map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`)
      .join("\n");
    extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${history}`;
  }
  // The embedded agent may stream through the normal text channel, so the system
  // prompt carries a strict JSON spoken-output contract before payload parsing.
  extraSystemPrompt = `${extraSystemPrompt}\n\n${VOICE_SPOKEN_OUTPUT_CONTRACT}`;

  const timeoutMs = voiceConfig.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;

  try {
    const result = await agentRuntime.runEmbeddedAgent({
      sessionId,
      sessionKey: resolvedSessionKey,
      sandboxSessionKey: resolveVoiceSandboxSessionKey(agentId, resolvedSessionKey),
      agentId,
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
      toolsAllow,
    });

    const text = extractSpokenTextFromPayloads((result.payloads ?? []) as VoiceResponsePayload[]);

    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
