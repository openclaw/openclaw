/**
 * Three-phase presence indicator for Telegram messages.
 *
 * Lifecycle:
 *   1. onMessageReceived — set "received" reaction (e.g. 👀) on the inbound message
 *      immediately, before queueing/dispatch. Lets the user know we got it even if
 *      the agent is busy.
 *   2. onProcessingStart — swap reaction to "working" (e.g. 👨‍💻) and begin a typing
 *      indicator loop calling sendChatAction every ~4s.
 *   3. onProcessingEnd — stop the typing loop and clear the reaction.
 *
 * Failures of the underlying Telegram API calls are swallowed (logged at warn level)
 * so presence indicator faults never break message dispatch.
 */
export interface PresenceIndicator {
  onMessageReceived(ctx: PresenceCtx): Promise<void>;
  onProcessingStart(ctx: PresenceCtx): Promise<void>;
  onProcessingEnd(ctx: PresenceCtx): Promise<void>;
}

export interface PresenceCtx {
  chatId: number | string;
  messageId: number;
  threadId?: number;
}

export interface PresenceConfig {
  /** Enable the typing-indicator loop while the agent processes. Default: true. */
  typing?: boolean;
  /** Emoji to set on the user's message when received. `null` disables reactions. */
  reaction?: string | null;
  /** Emoji to swap to while the agent is actively working. */
  workingReaction?: string | null;
}

/** Default received-emoji (Telegram free-reaction allowlist as of Bot API 7.0). */
export const DEFAULT_PRESENCE_REACTION = "👀";
/** Default working-emoji (Telegram free-reaction allowlist as of Bot API 7.0). */
export const DEFAULT_PRESENCE_WORKING_REACTION = "👨‍💻";

/** Interval between sendChatAction("typing") refreshes (Telegram auto-decays in ~5s). */
export const PRESENCE_TYPING_INTERVAL_MS = 4000;
/** Suppress the first typing tick if processing finishes within this window. */
export const PRESENCE_TYPING_DEBOUNCE_MS = 400;
/** Watchdog timeout: clear orphan reactions if onProcessingEnd never fires. */
export const PRESENCE_REACTION_TTL_MS = 60_000;

export type PresenceLogger = (level: "warn", message: string) => void;

/**
 * Reaction payload accepted by Telegram Bot API `setMessageReaction`.
 *
 * grammY narrows the emoji to a string-literal union from Bot API 7.0; for the
 * presence indicator we only need the structural shape — callers cast as
 * needed.
 */
export type PresenceReaction = { type: "emoji"; emoji: string };

// Reaction sink accepts the structural shape. Callers (bot-core) bind the
// grammY-typed setMessageReaction here through a runtime cast since both
// shapes are interchangeable at the JSON layer.
type ReactionApi = (
  chatId: number | string,
  messageId: number,
  reactions: PresenceReaction[],
) => Promise<unknown>;

type SendChatActionFn = (
  chatId: number | string,
  action: "typing",
  threadParams?: { message_thread_id?: number },
) => Promise<unknown>;

export interface TelegramPresenceIndicatorDeps {
  setMessageReaction: ReactionApi | null;
  sendChatAction: SendChatActionFn;
  config?: PresenceConfig;
  logger?: PresenceLogger;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  setInterval?: typeof setInterval;
  /** Override for tests. */
  clearInterval?: typeof clearInterval;
  /** Override for tests. */
  setTimeout?: typeof setTimeout;
  /** Override for tests. */
  clearTimeout?: typeof clearTimeout;
}

type TypingLoopEntry = {
  refs: number;
  timerHandle: ReturnType<typeof setTimeout> | null;
  intervalHandle: ReturnType<typeof setInterval> | null;
  threadId?: number;
};

type ReactionWatchdog = {
  timer: ReturnType<typeof setTimeout>;
};

function loopKey(chatId: number | string, threadId?: number): string {
  return threadId != null ? `${String(chatId)}:${threadId}` : `${String(chatId)}:main`;
}

function reactionKey(chatId: number | string, messageId: number): string {
  return `${String(chatId)}:${messageId}`;
}

/**
 * Telegram-specific presence indicator. Wires Telegram Bot API setMessageReaction
 * and sendChatAction("typing") to the three lifecycle hooks.
 */
export function createTelegramPresenceIndicator(
  deps: TelegramPresenceIndicatorDeps,
): PresenceIndicator {
  const cfg = deps.config ?? {};
  const typingEnabled = cfg.typing !== false;
  const receivedEmoji =
    cfg.reaction === null ? null : (cfg.reaction ?? DEFAULT_PRESENCE_REACTION);
  const workingEmoji =
    cfg.workingReaction === null
      ? null
      : (cfg.workingReaction ?? DEFAULT_PRESENCE_WORKING_REACTION);
  const setReaction = deps.setMessageReaction;
  const sendChatAction = deps.sendChatAction;
  const log = deps.logger ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());
  const setIntervalImpl = deps.setInterval ?? setInterval;
  const clearIntervalImpl = deps.clearInterval ?? clearInterval;
  const setTimeoutImpl = deps.setTimeout ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeout ?? clearTimeout;

  const typingLoops = new Map<string, TypingLoopEntry>();
  const reactionWatchdogs = new Map<string, ReactionWatchdog>();
  const processingStartTimes = new Map<string, number>();

  const safeSetReaction = async (
    chatId: number | string,
    messageId: number,
    emoji: string | null,
  ): Promise<void> => {
    if (!setReaction) {
      return;
    }
    const reactions = emoji ? [{ type: "emoji" as const, emoji }] : [];
    try {
      await setReaction(chatId, messageId, reactions);
    } catch (err) {
      log("warn", `presence: setMessageReaction failed for ${chatId}/${messageId}: ${String(err)}`);
    }
  };

  const safeSendTyping = async (
    chatId: number | string,
    threadId?: number,
  ): Promise<void> => {
    try {
      await sendChatAction(
        chatId,
        "typing",
        threadId != null ? { message_thread_id: threadId } : undefined,
      );
    } catch (err) {
      log("warn", `presence: sendChatAction(typing) failed for ${chatId}: ${String(err)}`);
    }
  };

  const scheduleReactionWatchdog = (ctx: PresenceCtx): void => {
    if (!setReaction || workingEmoji === null) {
      return;
    }
    const key = reactionKey(ctx.chatId, ctx.messageId);
    const existing = reactionWatchdogs.get(key);
    if (existing) {
      clearTimeoutImpl(existing.timer);
    }
    const timer = setTimeoutImpl(() => {
      reactionWatchdogs.delete(key);
      void safeSetReaction(ctx.chatId, ctx.messageId, null);
    }, PRESENCE_REACTION_TTL_MS);
    reactionWatchdogs.set(key, { timer });
  };

  const cancelReactionWatchdog = (ctx: PresenceCtx): void => {
    const key = reactionKey(ctx.chatId, ctx.messageId);
    const existing = reactionWatchdogs.get(key);
    if (existing) {
      clearTimeoutImpl(existing.timer);
      reactionWatchdogs.delete(key);
    }
  };

  const acquireTypingLoop = (ctx: PresenceCtx): void => {
    if (!typingEnabled) {
      return;
    }
    const key = loopKey(ctx.chatId, ctx.threadId);
    const existing = typingLoops.get(key);
    if (existing) {
      existing.refs += 1;
      return;
    }
    // First processor for this chat+thread. Defer the first sendChatAction by
    // PRESENCE_TYPING_DEBOUNCE_MS so quick-replies don't flicker the indicator.
    const entry: TypingLoopEntry = {
      refs: 1,
      timerHandle: null,
      intervalHandle: null,
      threadId: ctx.threadId,
    };
    entry.timerHandle = setTimeoutImpl(() => {
      entry.timerHandle = null;
      const current = typingLoops.get(key);
      if (!current || current.refs <= 0) {
        return;
      }
      void safeSendTyping(ctx.chatId, ctx.threadId);
      current.intervalHandle = setIntervalImpl(() => {
        void safeSendTyping(ctx.chatId, ctx.threadId);
      }, PRESENCE_TYPING_INTERVAL_MS);
    }, PRESENCE_TYPING_DEBOUNCE_MS);
    typingLoops.set(key, entry);
  };

  const releaseTypingLoop = (ctx: PresenceCtx): void => {
    if (!typingEnabled) {
      return;
    }
    const key = loopKey(ctx.chatId, ctx.threadId);
    const entry = typingLoops.get(key);
    if (!entry) {
      return;
    }
    entry.refs -= 1;
    if (entry.refs > 0) {
      return;
    }
    if (entry.timerHandle) {
      clearTimeoutImpl(entry.timerHandle);
      entry.timerHandle = null;
    }
    if (entry.intervalHandle) {
      clearIntervalImpl(entry.intervalHandle);
      entry.intervalHandle = null;
    }
    typingLoops.delete(key);
  };

  return {
    async onMessageReceived(ctx) {
      if (!setReaction || receivedEmoji === null) {
        return;
      }
      await safeSetReaction(ctx.chatId, ctx.messageId, receivedEmoji);
    },

    async onProcessingStart(ctx) {
      processingStartTimes.set(reactionKey(ctx.chatId, ctx.messageId), now());
      if (setReaction && workingEmoji !== null) {
        await safeSetReaction(ctx.chatId, ctx.messageId, workingEmoji);
      }
      acquireTypingLoop(ctx);
      scheduleReactionWatchdog(ctx);
    },

    async onProcessingEnd(ctx) {
      processingStartTimes.delete(reactionKey(ctx.chatId, ctx.messageId));
      releaseTypingLoop(ctx);
      cancelReactionWatchdog(ctx);
      if (setReaction && (receivedEmoji !== null || workingEmoji !== null)) {
        await safeSetReaction(ctx.chatId, ctx.messageId, null);
      }
    },
  };
}

/**
 * No-op presence indicator. Used when no real implementation is configured —
 * keeps callsites uniform without a null check.
 */
export const NOOP_PRESENCE_INDICATOR: PresenceIndicator = {
  async onMessageReceived() {},
  async onProcessingStart() {},
  async onProcessingEnd() {},
};
