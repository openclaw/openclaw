/**
 * Episode Memory Hooks
 *
 * Registers lifecycle hooks for:
 * 1. Session finalization (before_reset) - generates episode from transcript
 * 2. Context injection (before_prompt_build) - injects relevant past sessions
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-episodes";
import type { EpisodesConfig } from "./config.js";
import type { EpisodeDb } from "./db.js";
import type { EmbeddingConfig } from "./embedding.js";
import { embed } from "./embedding.js";
import { generateEpisode, MIN_MESSAGES_FOR_EPISODE } from "./episode-generator.js";
import type { ExtractionConfig } from "./episode-generator.js";
import { formatEpisodeContext } from "./format.js";

type HookDeps = {
  db: EpisodeDb;
  embeddingConfig: EmbeddingConfig;
  extractionConfig: ExtractionConfig;
  config: EpisodesConfig;
};

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

/** Extract messages from the before_reset event payload. */
function extractMessages(rawMessages: unknown[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const msg = raw as Record<string, unknown>;
    if (typeof msg.role !== "string") {
      continue;
    }
    messages.push({
      role: msg.role,
      content: msg.content as TranscriptMessage["content"],
    });
  }
  return messages;
}

export function registerHooks(api: OpenClawPluginApi, deps: HookDeps): void {
  const { db, embeddingConfig, extractionConfig, config } = deps;

  // =========================================================================
  // Session Finalization (before_reset)
  //
  // Fires when /new or /reset clears a session. The event includes messages
  // and the session file path, so we can generate an episode before the
  // transcript is lost.
  // =========================================================================
  api.on("before_reset", async (event, ctx) => {
    // --fast resets set this flag to skip episode capture entirely
    const skipKey = Symbol.for("openclaw.skipBeforeResetHook");
    if ((globalThis as Record<symbol, unknown>)[skipKey]) {
      return;
    }

    const messages = event.messages ? extractMessages(event.messages) : [];
    if (messages.length < MIN_MESSAGES_FOR_EPISODE) {
      api.logger.info?.(`memory-episodes: skipping episode (only ${messages.length} messages)`);
      return;
    }

    const sessionId = ctx.sessionId;
    const agentId = ctx.agentId ?? "unknown";
    // Use agentId as userId fallback; real user id comes from session context
    const userId = agentId;

    try {
      const summary = await generateEpisode(messages, extractionConfig);
      const embedding = await embed(summary.summary, embeddingConfig);

      await db.upsertEpisode({
        sourceSessionId: sessionId,
        sourceSessionKey: ctx.sessionKey,
        userId,
        agentId,
        channelId: ctx.channelId ?? undefined,
        summary: summary.summary,
        keyDecisions: summary.keyDecisions,
        filesTouched: summary.filesTouched,
        tasksCompleted: summary.tasksCompleted,
        tasksPending: summary.tasksPending,
        errorsEncountered: summary.errorsEncountered,
        endedAt: new Date(),
        messageCount: messages.length,
        summaryEmbedding: embedding,
      });

      api.logger.info?.(
        `memory-episodes: episode created for session ${sessionId} (${messages.length} messages)`,
      );
    } catch (err) {
      api.logger.warn(
        `memory-episodes: failed to create episode for session ${sessionId}: ${String(err)}`,
      );
    }
  });

  // =========================================================================
  // Context Injection (before_prompt_build)
  //
  // Injects relevant past session episodes into the prompt context so the
  // agent has awareness of previous work.
  // =========================================================================
  api.on("before_prompt_build", async (event, ctx) => {
    if (!event.prompt || event.prompt.length < 5) {
      return;
    }

    const agentId = ctx.agentId ?? "unknown";
    const userId = agentId;

    try {
      // Fetch most recent episode (continuation context)
      const recent = await db.getRecentEpisodes(userId, ctx.channelId ?? undefined, 1);
      const continuation = recent.length > 0 ? recent[0] : null;

      // Fetch semantically similar episodes
      const embedding = await embed(event.prompt, embeddingConfig);
      const semanticResults = await db.searchEpisodes({
        embedding,
        userId,
        channelId: config.retrieval.preferSameChannel ? (ctx.channelId ?? undefined) : undefined,
        maxResults: config.retrieval.maxResults,
        maxAgeDays: config.retrieval.maxAgeDays,
        threshold: config.retrieval.similarityThreshold,
      });

      const contextStr = formatEpisodeContext(continuation, semanticResults);
      if (!contextStr) {
        return;
      }

      api.logger.info?.(
        `memory-episodes: injecting ${semanticResults.length} episode(s) into context`,
      );

      return { prependContext: contextStr };
    } catch (err) {
      api.logger.warn(`memory-episodes: context injection failed: ${String(err)}`);
    }
  });
}
