/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";
import type { VoiceCallConfig } from "./config.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";

export type VoiceResponseParams = {
  /** Voice call config */
  voiceConfig: VoiceCallConfig;
  /** Core OpenClaw config */
  coreConfig: CoreConfig;
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
};

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
};

/**
 * Generate a voice response using the embedded Pi agent with full tool support.
 * Uses the same agent infrastructure as messaging for consistent behavior.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const { voiceConfig, callId, from, transcript, userMessage, coreConfig } = params;

  if (!coreConfig) {
    return { text: null, error: "Core config unavailable for voice response" };
  }

  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : "Unable to load core agent dependencies",
    };
  }
  const cfg = coreConfig;

  const configuredAgentId = voiceConfig.responseAgentId?.trim();
  const agentId = configuredAgentId || "main";
  const sessionKeyPrefix = voiceConfig.responseSessionKeyPrefix?.trim() || "voice";

  // Build voice-specific session key based on phone number
  const normalizedPhone = from.replace(/\D/g, "");
  const buildSessionKey = (id: string): string =>
    id === "main"
      ? `${sessionKeyPrefix}:${normalizedPhone}`
      : `${sessionKeyPrefix}:${id}:${normalizedPhone}`;
  const sessionKey = buildSessionKey(agentId);

  // Resolve paths
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = deps.resolveAgentDir(cfg, agentId);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  console.log(`[voice-call] Using response agent "${agentId}" for voice responses`);

  // Load or create session entry
  const sessionStore = deps.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

  if (!sessionEntry) {
    sessionEntry = {
      sessionId: crypto.randomUUID(),
      updatedAt: now,
    };
    sessionStore[sessionKey] = sessionEntry;
    await deps.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  // Resolve model from config
  const modelRef = voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  // Resolve thinking level
  const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

  // Resolve agent identity for personalized prompt
  const identity = deps.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  // Build system prompt with conversation history
  const basePrompt =
    voiceConfig.responseSystemPrompt ??
    `You are ${agentName}, a helpful voice assistant on a phone call. Always respond with a short spoken reply (1-2 sentences). Never output the tokens HEARTBEAT_OK or NO_REPLY. Do not use markdown or code blocks. If unsure, ask a brief clarifying question. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;

  let extraSystemPrompt = basePrompt;
  if (transcript.length > 0) {
    const history = transcript
      .map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`)
      .join("\n");
    extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${history}`;
  }

  // Resolve timeout
  const timeoutMs = voiceConfig.responseTimeoutMs ?? deps.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;
  const lane = agentId === "main" ? "voice" : `voice:${agentId}`;

  try {
    const result = await deps.runEmbeddedPiAgent({
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
      lane,
      extraSystemPrompt,
      agentDir,
    });

    // Extract text from payloads
    const heartbeatTokens = ["HEARTBEAT_OK", "NO_REPLY"];
    let sawSentinel = false;
    const stripHeartbeatTokens = (value: string): string => {
      let output = value;
      for (const token of heartbeatTokens) {
        const pattern = new RegExp(`\\b${token}\\b`, "g");
        if (pattern.test(output)) {
          sawSentinel = true;
        }
        output = output.replace(pattern, "");
      }
      return output.replace(/\s+/g, " ").trim();
    };

    const rawTexts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const texts = rawTexts.map((value) => stripHeartbeatTokens(value)).filter(Boolean);

    const rawText = rawTexts.join(" ").trim();
    const rawPreview = rawText ? rawText.slice(0, 240) : "";

    let text = texts.join(" ") || null;

    // Guardrail: the agent may emit heartbeat/silent reply sentinels.
    // Never speak those out loud on a phone call; treat them as non-content.
    if (text) {
      text = stripHeartbeatTokens(text);
      if (!text) {
        text = null;
      }
    }

    if (!text && result.meta.aborted) {
      if (rawPreview) {
        console.warn(
          `[voice-call] Voice response empty (reason=aborted) raw="${rawPreview}"`,
        );
      } else {
        console.warn("[voice-call] Voice response empty (reason=aborted) raw=<empty>");
      }
      return { text: null, error: "Response generation was aborted" };
    }

    if (!text && sawSentinel) {
      if (rawPreview) {
        console.warn(
          `[voice-call] Voice response empty (reason=suppressed-sentinel) raw="${rawPreview}"`,
        );
      } else {
        console.warn(
          "[voice-call] Voice response empty (reason=suppressed-sentinel) raw=<empty>",
        );
      }
      return { text: null };
    }

    if (!text) {
      if (rawPreview) {
        console.warn(`[voice-call] Voice response empty (reason=empty) raw="${rawPreview}"`);
      } else {
        console.warn("[voice-call] Voice response empty (reason=empty) raw=<empty>");
      }
      return { text: null };
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
