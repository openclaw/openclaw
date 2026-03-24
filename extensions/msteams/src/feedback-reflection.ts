/**
 * Background reflection triggered by negative user feedback (thumbs-down).
 *
 * Flow:
 * 1. User thumbs-down → invoke handler acks immediately
 * 2. This module runs in the background (fire-and-forget)
 * 3. Reads recent session context
 * 4. Sends a synthetic reflection prompt to the agent
 * 5. Stores the derived learning in session
 * 6. Optionally sends a proactive follow-up to the user
 */

import {
  dispatchReplyFromConfigWithSettledDispatcher,
  type OpenClawConfig,
} from "../runtime-api.js";
import type { StoredConversationReference } from "./conversation-store.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { buildConversationReference, sendMSTeamsMessages } from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getMSTeamsRuntime } from "./runtime.js";

/** Default cooldown between reflections per session (5 minutes). */
const DEFAULT_COOLDOWN_MS = 300_000;

/** Max chars of the thumbed-down response to include in the reflection prompt. */
const MAX_RESPONSE_CHARS = 500;

/** Tracks last reflection time per session to enforce cooldown. */
const lastReflectionBySession = new Map<string, number>();

/** Maximum cooldown entries before pruning expired ones. */
const MAX_COOLDOWN_ENTRIES = 500;

/** Prune expired cooldown entries to prevent unbounded memory growth. */
function pruneExpiredCooldowns(cooldownMs: number): void {
  if (lastReflectionBySession.size <= MAX_COOLDOWN_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [key, time] of lastReflectionBySession) {
    if (now - time >= cooldownMs) {
      lastReflectionBySession.delete(key);
    }
  }
}

export type FeedbackEvent = {
  type: "custom";
  event: "feedback";
  ts: number;
  messageId: string;
  value: "positive" | "negative";
  comment?: string;
  sessionKey: string;
  agentId: string;
  conversationId: string;
  reflectionLearning?: string;
};

export function buildFeedbackEvent(params: {
  messageId: string;
  value: "positive" | "negative";
  comment?: string;
  sessionKey: string;
  agentId: string;
  conversationId: string;
}): FeedbackEvent {
  return {
    type: "custom",
    event: "feedback",
    ts: Date.now(),
    messageId: params.messageId,
    value: params.value,
    comment: params.comment,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    conversationId: params.conversationId,
  };
}

export type ParsedReflectionResponse = {
  learning: string;
  followUp: boolean;
  userMessage?: string;
};

export function buildReflectionPrompt(params: {
  thumbedDownResponse?: string;
  userComment?: string;
}): string {
  const parts: string[] = ["A user indicated your previous response wasn't helpful."];

  if (params.thumbedDownResponse) {
    const truncated =
      params.thumbedDownResponse.length > MAX_RESPONSE_CHARS
        ? `${params.thumbedDownResponse.slice(0, MAX_RESPONSE_CHARS)}...`
        : params.thumbedDownResponse;
    parts.push(`\nYour response was:\n> ${truncated}`);
  }

  if (params.userComment) {
    parts.push(`\nUser's comment: "${params.userComment}"`);
  }

  parts.push(
    "\nBriefly reflect: what could you improve? Consider tone, length, " +
      "accuracy, relevance, and specificity. Reply with a single JSON object " +
      'only, no markdown or prose, using this exact shape:\n{"learning":"...",' +
      '"followUp":false,"userMessage":""}\n' +
      "- learning: a short internal adjustment note (1-2 sentences) for your " +
      "future behavior in this conversation.\n" +
      "- followUp: true only if the user needs a direct follow-up message.\n" +
      "- userMessage: only the exact user-facing message to send; empty string " +
      "when followUp is false.",
  );

  return parts.join("\n");
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "no") {
      return false;
    }
  }
  return undefined;
}

function parseStructuredReflectionValue(value: unknown): ParsedReflectionResponse | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as {
    learning?: unknown;
    followUp?: unknown;
    userMessage?: unknown;
  };
  const learning = typeof candidate.learning === "string" ? candidate.learning.trim() : undefined;
  if (!learning) {
    return null;
  }

  return {
    learning,
    followUp: parseBooleanLike(candidate.followUp) ?? false,
    userMessage:
      typeof candidate.userMessage === "string" && candidate.userMessage.trim()
        ? candidate.userMessage.trim()
        : undefined,
  };
}

export function parseReflectionResponse(text: string): ParsedReflectionResponse | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [
    trimmed,
    ...(trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.slice(1, 2) ?? []),
  ];

  for (const candidateText of candidates) {
    const candidate = candidateText.trim();
    if (!candidate) {
      continue;
    }
    try {
      const parsed = parseStructuredReflectionValue(JSON.parse(candidate));
      if (parsed) {
        return parsed;
      }
    } catch {
      // Fall through to the next parse strategy.
    }
  }

  // Safe fallback: keep the internal learning, but never auto-message the user.
  return {
    learning: trimmed,
    followUp: false,
  };
}

/**
 * Check if a reflection is allowed (cooldown not active).
 */
export function isReflectionAllowed(sessionKey: string, cooldownMs?: number): boolean {
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastTime = lastReflectionBySession.get(sessionKey);
  if (lastTime == null) {
    return true;
  }
  return Date.now() - lastTime >= cooldown;
}

/**
 * Record that a reflection was run for a session.
 */
export function recordReflectionTime(sessionKey: string, cooldownMs?: number): void {
  lastReflectionBySession.set(sessionKey, Date.now());
  pruneExpiredCooldowns(cooldownMs ?? DEFAULT_COOLDOWN_MS);
}

/**
 * Clear reflection cooldown tracking (for tests).
 */
export function clearReflectionCooldowns(): void {
  lastReflectionBySession.clear();
}

export type RunFeedbackReflectionParams = {
  cfg: OpenClawConfig;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  sessionKey: string;
  agentId: string;
  conversationId: string;
  feedbackMessageId: string;
  thumbedDownResponse?: string;
  userComment?: string;
  log: MSTeamsMonitorLogger;
};

/**
 * Run a background reflection after negative feedback.
 * This is designed to be called fire-and-forget (don't await in the invoke handler).
 */
export async function runFeedbackReflection(params: RunFeedbackReflectionParams): Promise<void> {
  const { cfg, log, sessionKey } = params;
  const msteamsCfg = cfg.channels?.msteams;

  // Check cooldown
  const cooldownMs = msteamsCfg?.feedbackReflectionCooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (!isReflectionAllowed(sessionKey, cooldownMs)) {
    log.debug?.("skipping reflection (cooldown active)", { sessionKey });
    return;
  }

  // Record cooldown after successful dispatch (not before) so transient
  // failures don't suppress future reflection attempts.

  const core = getMSTeamsRuntime();
  const reflectionPrompt = buildReflectionPrompt({
    thumbedDownResponse: params.thumbedDownResponse,
    userComment: params.userComment,
  });

  // Use the agentId from the feedback handler (already resolved with correct routing)
  // instead of re-resolving, which could yield a different agent in peer-specific setups.
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: params.agentId,
  });

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Teams",
    from: "system",
    body: reflectionPrompt,
    envelope: envelopeOptions,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: reflectionPrompt,
    RawBody: reflectionPrompt,
    CommandBody: reflectionPrompt,
    From: `msteams:system:${params.conversationId}`,
    To: `conversation:${params.conversationId}`,
    SessionKey: params.sessionKey,
    ChatType: "direct" as const,
    SenderName: "system",
    SenderId: "system",
    Provider: "msteams" as const,
    Surface: "msteams" as const,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: false,
    OriginatingChannel: "msteams" as const,
    OriginatingTo: `conversation:${params.conversationId}`,
  });

  // Capture the reflection response instead of sending it directly.
  // We only want to proactively message if the agent decides to follow up.
  let reflectionResponse = "";

  const noopTypingCallbacks = {
    onReplyStart: async () => {},
    onIdle: () => {},
    onCleanup: () => {},
  };

  const { dispatcher, replyOptions } = core.channel.reply.createReplyDispatcherWithTyping({
    deliver: async (payload) => {
      if (payload.text) {
        reflectionResponse += (reflectionResponse ? "\n" : "") + payload.text;
      }
    },
    typingCallbacks: noopTypingCallbacks,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, params.agentId),
    onError: (err) => {
      log.debug?.("reflection reply error", { error: String(err) });
    },
  });

  try {
    await dispatchReplyFromConfigWithSettledDispatcher({
      ctxPayload,
      cfg,
      dispatcher,
      onSettled: () => {},
      replyOptions,
    });
  } catch (err) {
    log.error("reflection dispatch failed", { error: String(err) });
    // Don't record cooldown — allow retry on next feedback
    return;
  }

  if (!reflectionResponse.trim()) {
    log.debug?.("reflection produced no output");
    return;
  }

  const parsedReflection = parseReflectionResponse(reflectionResponse);
  if (!parsedReflection) {
    log.debug?.("reflection produced no structured output");
    return;
  }

  // Reflection succeeded — record cooldown now
  recordReflectionTime(sessionKey, cooldownMs);

  log.info("reflection complete", {
    sessionKey,
    responseLength: reflectionResponse.length,
    followUp: parsedReflection.followUp,
  });

  // Store the learning in the session
  try {
    await storeSessionLearning({
      storePath,
      sessionKey: params.sessionKey,
      learning: parsedReflection.learning,
    });
  } catch (err) {
    log.debug?.("failed to store reflection learning", { error: String(err) });
  }

  const conversationType = params.conversationRef.conversation?.conversationType?.toLowerCase();
  const isDirectMessage = conversationType === "personal";
  const shouldNotify =
    isDirectMessage && parsedReflection.followUp && Boolean(parsedReflection.userMessage);

  if (shouldNotify) {
    try {
      const baseRef = buildConversationReference(params.conversationRef);
      const proactiveRef = { ...baseRef, activityId: undefined };

      await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
        await ctx.sendActivity({
          type: "message",
          text: parsedReflection.userMessage!,
        });
      });
      log.info("sent reflection follow-up", { sessionKey });
    } catch (err) {
      log.debug?.("failed to send reflection follow-up", { error: String(err) });
    }
  } else if (parsedReflection.followUp && !isDirectMessage) {
    log.debug?.("skipping reflection follow-up outside direct message", {
      sessionKey,
      conversationType,
    });
  }
}

/**
 * Store a learning derived from feedback reflection in a session companion file.
 */
async function storeSessionLearning(params: {
  storePath: string;
  sessionKey: string;
  learning: string;
}): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const safeKey = params.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const learningsFile = path.join(params.storePath, `${safeKey}.learnings.json`);

  let learnings: string[] = [];
  try {
    const existing = await fs.readFile(learningsFile, "utf-8");
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed)) {
      learnings = parsed;
    }
  } catch {
    // File doesn't exist yet — start fresh.
  }

  learnings.push(params.learning);

  // Cap at 10 learnings to avoid unbounded growth
  if (learnings.length > 10) {
    learnings = learnings.slice(-10);
  }

  await fs.mkdir(path.dirname(learningsFile), { recursive: true });
  await fs.writeFile(learningsFile, JSON.stringify(learnings, null, 2), "utf-8");
}

/**
 * Load session learnings for injection into extraSystemPrompt.
 */
export async function loadSessionLearnings(
  storePath: string,
  sessionKey: string,
): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const learningsFile = path.join(storePath, `${safeKey}.learnings.json`);

  try {
    const content = await fs.readFile(learningsFile, "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
