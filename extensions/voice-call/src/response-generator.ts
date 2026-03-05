/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 *
 * Streams sentences as the LLM generates them so TTS can start on the first
 * sentence while the model is still producing the rest of the response.
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

// Sentence boundary: sentence-ending punctuation followed by whitespace.
// Avoids splitting on common abbreviations (Mr., Dr., U.S., etc.) by
// requiring the character before the period to NOT be an uppercase letter
// (which catches most single-letter abbreviations) or be preceded by at
// least two word characters (catches "Mr.", "Dr.", etc. but allows
// "I did it. Next..." to split).
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z"])/;

/**
 * Bridges onPartialReply callbacks to an AsyncIterable of sentences.
 *
 * The LLM streams cumulative text via onPartialReply. This class detects
 * sentence boundaries and yields complete sentences as they appear.
 */
export class SentenceStream {
  private queue: string[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private yieldedLength = 0;

  /** Called with cumulative text from onPartialReply. */
  push(cumulativeText: string): void {
    const unprocessed = cumulativeText.slice(this.yieldedLength);
    if (!unprocessed) return;

    // Split on sentence boundaries
    const parts = unprocessed.split(SENTENCE_BOUNDARY);

    // All parts except the last are complete sentences
    for (let i = 0; i < parts.length - 1; i++) {
      const sentence = parts[i].trim();
      if (sentence) {
        this.yieldedLength += parts[i].length;
        // Account for the whitespace that was the split point
        const nextStart = cumulativeText.indexOf(parts[i + 1], this.yieldedLength);
        if (nextStart > this.yieldedLength) {
          this.yieldedLength = nextStart;
        }
        this.queue.push(sentence);
      }
    }

    // Wake up the consumer if waiting
    if (this.queue.length > 0 && this.waiter) {
      this.waiter();
      this.waiter = null;
    }
  }

  /** Signal that the LLM is done. Yields any remaining text as final sentence. */
  finish(finalText?: string): void {
    // If we have final text from payloads, use whatever we haven't yielded yet
    const source = finalText ?? "";
    const remaining = source.slice(this.yieldedLength).trim();
    if (remaining) {
      this.queue.push(remaining);
    }
    this.done = true;
    if (this.waiter) {
      this.waiter();
      this.waiter = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) break;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/**
 * Generate a voice response, streaming sentences as the LLM produces them.
 *
 * Returns an async iterable of sentences and a promise for the final result
 * (used for transcript recording after all sentences have been spoken).
 */
export function generateVoiceResponseStream(params: VoiceResponseParams): {
  sentences: AsyncIterable<string>;
  result: Promise<VoiceResponseResult>;
} {
  const sentenceStream = new SentenceStream();

  const result = (async (): Promise<VoiceResponseResult> => {
    const { voiceConfig, callId, from, transcript, userMessage, coreConfig } = params;

    if (!coreConfig) {
      sentenceStream.finish();
      return { text: null, error: "Core config unavailable for voice response" };
    }

    let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
    try {
      deps = await loadCoreAgentDeps();
    } catch (err) {
      sentenceStream.finish();
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

    try {
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
      const modelRef =
        voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
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

      const agentResult = await deps.runEmbeddedPiAgent({
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
        onPartialReply: ({ text }) => {
          if (text) sentenceStream.push(text);
        },
      });

      // Extract final text from payloads
      const texts = (agentResult.payloads ?? [])
        .filter((p) => p.text && !p.isError)
        .map((p) => p.text?.trim())
        .filter(Boolean);

      const text = texts.join(" ") || null;

      // Finish the sentence stream with the authoritative final text
      sentenceStream.finish(text ?? undefined);

      if (!text && agentResult.meta?.aborted) {
        return { text: null, error: "Response generation was aborted" };
      }

      return { text };
    } catch (err) {
      console.error(`[voice-call] Response generation failed:`, err);
      sentenceStream.finish();
      return { text: null, error: String(err) };
    }
  })();

  return { sentences: sentenceStream, result };
}
