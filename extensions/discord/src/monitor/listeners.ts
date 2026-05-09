import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  type Client,
  InteractionCreateListener,
  MessageDeleteListener,
  MessageCreateListener,
  PresenceUpdateListener,
  ThreadUpdateListener,
  TypingStartListener,
} from "../internal/discord.js";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";
export { DiscordReactionListener, DiscordReactionRemoveListener } from "./listeners.reactions.js";
import { setPresence } from "./presence-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";

type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];
export type DiscordInteractionEvent = Parameters<InteractionCreateListener["handle"]>[0];
export type DiscordTypingStartEvent = Parameters<TypingStartListener["handle"]>[0];
export type DiscordMessageDeleteEvent = Parameters<MessageDeleteListener["handle"]>[0];

export type DiscordInboundActivityEmitter = (event: {
  source: "message" | "typing" | "delete" | "update";
  key: string;
  authorId?: string;
  messageId?: string;
  channelId: string;
  timestamp: number;
  raw?: unknown;
}) => Promise<void>;

export type DiscordMessageHandler = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal },
) => Promise<void>;

export function registerDiscordListener(listeners: Array<object>, listener: object) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}

export class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
    private onEvent?: () => void,
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    this.onEvent?.();
    // Fire-and-forget: hand off to the handler without blocking gateway dispatch.
    // Per-session ordering is owned by the message run queue.
    void Promise.resolve()
      .then(() => this.handler(data, client))
      .catch((err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
      });
  }
}

export class DiscordTypingStartListener extends TypingStartListener {
  constructor(
    private accountId: string,
    private emitActivity: DiscordInboundActivityEmitter,
    private logger?: Logger,
    private onEvent?: () => void,
  ) {
    super();
  }

  async handle(data: DiscordTypingStartEvent) {
    this.onEvent?.();
    const userId = typeof data.user_id === "string" ? data.user_id : undefined;
    const channelId = typeof data.channel_id === "string" ? data.channel_id : undefined;
    if (!userId || !channelId) {
      return;
    }
    const key = `discord:${this.accountId}:${channelId}:${userId}`;
    void this.emitActivity({
      source: "typing",
      key,
      authorId: userId,
      channelId,
      timestamp: Date.now(),
      raw: data,
    }).catch((err) => {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord typing activity hook failed: ${String(err)}`));
    });
  }
}

export class DiscordMessageDeleteListener extends MessageDeleteListener {
  constructor(
    private accountId: string,
    private emitActivity: DiscordInboundActivityEmitter,
    private logger?: Logger,
    private onEvent?: () => void,
  ) {
    super();
  }

  async handle(data: DiscordMessageDeleteEvent) {
    this.onEvent?.();
    const channelId = typeof data.channel_id === "string" ? data.channel_id : undefined;
    const messageId = typeof data.id === "string" ? data.id : undefined;
    if (!channelId || !messageId) {
      return;
    }
    // Discord delete payloads do not include the original author. Use a
    // channel-scoped key so sibling hooks can still cancel their own side state.
    const key = `discord:${this.accountId}:${channelId}:*`;
    void this.emitActivity({
      source: "delete",
      key,
      messageId,
      channelId,
      timestamp: Date.now(),
      raw: data,
    }).catch((err) => {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord delete activity hook failed: ${String(err)}`));
    });
  }
}

export class DiscordInteractionListener extends InteractionCreateListener {
  constructor(
    private logger?: Logger,
    private onEvent?: () => void,
  ) {
    super();
  }

  async handle(data: DiscordInteractionEvent, client: Client) {
    this.onEvent?.();
    // Hand off immediately so slash/component handling can wait on session locks
    // or compaction without blocking later gateway events.
    void Promise.resolve()
      .then(() => client.handleInteraction(data as Parameters<Client["handleInteraction"]>[0], {}))
      .catch((err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord interaction handler failed: ${String(err)}`));
      });
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];

export class DiscordPresenceListener extends PresenceUpdateListener {
  private logger?: Logger;
  private accountId?: string;

  constructor(params: { logger?: Logger; accountId?: string }) {
    super();
    this.logger = params.logger;
    this.accountId = params.accountId;
  }

  async handle(data: PresenceUpdateEvent) {
    try {
      const userId =
        "user" in data && data.user && typeof data.user === "object" && "id" in data.user
          ? data.user.id
          : undefined;
      if (!userId) {
        return;
      }
      setPresence(this.accountId, userId, data);
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    }
  }
}

type ThreadUpdateEvent = Parameters<ThreadUpdateListener["handle"]>[0];

export class DiscordThreadUpdateListener extends ThreadUpdateListener {
  constructor(
    private cfg: OpenClawConfig,
    private accountId: string,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: ThreadUpdateEvent) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: async () => {
        // Discord only fires THREAD_UPDATE when a field actually changes, so
        // `thread_metadata.archived === true` in this payload means the thread
        // just transitioned to the archived state.
        if (!isThreadArchived(data)) {
          return;
        }
        const threadId = "id" in data && typeof data.id === "string" ? data.id : undefined;
        if (!threadId) {
          return;
        }
        const logger = this.logger ?? discordEventQueueLog;
        const count = await closeDiscordThreadSessions({
          cfg: this.cfg,
          accountId: this.accountId,
          threadId,
        });
        if (count > 0) {
          logger.info("Discord thread archived — reset sessions", { threadId, count });
        }
      },
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-update handler failed: ${String(err)}`));
      },
    });
  }
}
