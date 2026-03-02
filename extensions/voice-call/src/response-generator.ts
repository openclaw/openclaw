/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";
import type { VoiceCallConfig } from "./config.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";

// Abbreviation prefixes we refuse to split on (conservative list).
// These end with a period but are not sentence boundaries.
const ABBREV_PREFIXES = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "inc",
  "ltd",
  "dept",
  "approx",
  "est",
  "jan",
  "feb",
  "mar",
  "apr",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]);

/**
 * Check whether `buf` ending in `. ` (or `.\n`) at offset `dotPos` is a real
 * sentence boundary.  `dotPos` is the index of the period character.
 */
function isSentenceBoundary(buf: string, dotPos: number): boolean {
  // Walk back to get the word before the period.
  let start = dotPos - 1;
  while (start >= 0 && /\w/.test(buf[start]!)) {
    start--;
  }
  const word = buf.slice(start + 1, dotPos).toLowerCase();
  return !ABBREV_PREFIXES.has(word);
}

/**
 * Flush complete sentences from the token buffer.
 * Returns [sentencesToFlush, remainingBuffer].
 * Forces a flush at a word boundary if the buffer exceeds maxLen.
 */
function extractSentences(buf: string, maxLen = 200): { flush: string; remaining: string } {
  let flushUpTo = -1;

  // Scan for `. `, `? `, `! `, `.\n`, `?\n`, `!\n`
  for (let i = 0; i < buf.length - 1; i++) {
    const ch = buf[i];
    const next = buf[i + 1];
    if (ch === "." && (next === " " || next === "\n")) {
      if (isSentenceBoundary(buf, i)) {
        flushUpTo = i + 1; // include the period but not the trailing space/newline
      }
    } else if ((ch === "?" || ch === "!") && (next === " " || next === "\n")) {
      flushUpTo = i + 1;
    }
  }

  if (flushUpTo !== -1) {
    return {
      flush: buf.slice(0, flushUpTo).trimEnd(),
      remaining: buf.slice(flushUpTo).trimStart(),
    };
  }

  // Force split at word boundary when buffer is too long
  if (buf.length >= maxLen) {
    const lastSpace = buf.lastIndexOf(" ", maxLen);
    const splitAt = lastSpace > 0 ? lastSpace : maxLen;
    return { flush: buf.slice(0, splitAt).trimEnd(), remaining: buf.slice(splitAt).trimStart() };
  }

  return { flush: "", remaining: buf };
}

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

  // Build voice-specific session key based on phone number
  const normalizedPhone = from.replace(/\D/g, "");
  const sessionKey = `voice:${normalizedPhone}`;
  const agentId = "main";

  // Resolve paths
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = deps.resolveAgentDir(cfg, agentId);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await deps.ensureAgentWorkspace({ dir: workspaceDir });

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
    `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;

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
      lane: "voice",
      extraSystemPrompt,
      agentDir,
    });

    // Extract text from payloads
    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const text = texts.join(" ") || null;

    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}

export type VoiceResponseStreamParams = VoiceResponseParams & {
  /** Called with each complete sentence as it becomes available. */
  onSentenceChunk: (text: string) => Promise<void>;
};

/**
 * Streaming variant of generateVoiceResponse.
 *
 * Uses onPartialReply to buffer tokens and emit complete sentences via
 * onSentenceChunk as Claude generates them.  The caller can start playing
 * audio immediately while generation continues.  Still returns the full
 * assembled text for transcript logging.
 */
export async function generateVoiceResponseStream(
  params: VoiceResponseStreamParams,
): Promise<VoiceResponseResult> {
  const { voiceConfig, callId, from, transcript, userMessage, coreConfig, onSentenceChunk } =
    params;

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

  const normalizedPhone = from.replace(/\D/g, "");
  const sessionKey = `voice:${normalizedPhone}`;
  const agentId = "main";

  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = deps.resolveAgentDir(cfg, agentId);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);

  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  const sessionStore = deps.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

  if (!sessionEntry) {
    sessionEntry = { sessionId: crypto.randomUUID(), updatedAt: now };
    sessionStore[sessionKey] = sessionEntry;
    await deps.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, { agentId });

  const modelRef = voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

  const identity = deps.resolveAgentIdentity(cfg, agentId);
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

  const timeoutMs = voiceConfig.responseTimeoutMs ?? deps.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;

  // Buffer for partial tokens; flushed to onSentenceChunk at sentence boundaries.
  let tokenBuf = "";
  // onPartialReply fires with cumulative snapshots (full text so far), not deltas.
  // Track how much of the snapshot we've already consumed so we only process new text.
  let lastSnapshotLen = 0;

  const flushChunk = async (text: string): Promise<void> => {
    try {
      await onSentenceChunk(text);
    } catch (err) {
      // Log and continue — a TTS failure for one chunk should not abort the full response.
      console.error(`[voice-call] Sentence chunk TTS error (continuing):`, err);
    }
  };

  // onPartialReply receives cumulative snapshots; extract only the new suffix.
  const onPartialReply = async (payload: { text: string }): Promise<void> => {
    const newText = payload.text.slice(lastSnapshotLen);
    lastSnapshotLen = payload.text.length;
    if (!newText) return;
    tokenBuf += newText;
    const { flush, remaining } = extractSentences(tokenBuf);
    if (flush) {
      tokenBuf = remaining;
      await flushChunk(flush);
    }
  };

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
      lane: "voice",
      extraSystemPrompt,
      agentDir,
      onPartialReply,
    });

    // Flush any remaining buffered text after generation completes.
    const leftover = tokenBuf.trim();
    if (leftover) {
      await flushChunk(leftover);
      tokenBuf = "";
    }

    // Assemble full text from payloads for transcript logging.
    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const text = texts.join(" ") || null;

    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Streaming response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
