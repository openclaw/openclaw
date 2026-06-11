// Discord plugin module implements listeners behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  type Client,
  InteractionCreateListener,
  MessageCreateListener,
  PresenceUpdateListener,
  ReadyListener,
  ResumedListener,
  ThreadUpdateListener,
} from "../internal/discord.js";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";
import type {
  DiscordInteractionEvent,
  DiscordMessageEvent,
  DiscordMessageHandler,
} from "./listeners.types.js";
export type {
  DiscordInteractionEvent,
  DiscordMessageEvent,
  DiscordMessageHandler,
} from "./listeners.types.js";
import { recordRecentDiscordInboundMessage } from "../recent-inbound.js";
import { backfillRecentDiscordInboundMessages } from "./reconnect-backfill.js";
export { DiscordReactionListener, DiscordReactionRemoveListener } from "./listeners.reactions.js";
import { setPresence } from "./presence-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";

type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

function readDiscordMessageId(data: DiscordMessageEvent): string | undefined {
  const candidate = data as DiscordMessageEvent & { message?: { id?: unknown } };
  return typeof candidate.message?.id === "string" && candidate.message.id.trim()
    ? candidate.message.id.trim()
    : typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim()
      : undefined;
}

function readDiscordChannelId(data: DiscordMessageEvent): string | undefined {
  const candidate = data as DiscordMessageEvent & {
    channelId?: unknown;
    message?: { channel_id?: unknown };
  };
  return typeof candidate.channel_id === "string" && candidate.channel_id.trim()
    ? candidate.channel_id.trim()
    : typeof candidate.channelId === "string" && candidate.channelId.trim()
      ? candidate.channelId.trim()
      : typeof candidate.message?.channel_id === "string" && candidate.message.channel_id.trim()
        ? candidate.message.channel_id.trim()
        : undefined;
}

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
    private accountId?: string,
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    this.onEvent?.();
    // Fire-and-forget: hand off to the handler without blocking gateway dispatch.
    // Per-session ordering is owned by the message run queue.
    void Promise.resolve()
      .then(() => this.handler(data, client))
      .then(() => {
        recordRecentDiscordInboundMessage({
          accountId: this.accountId,
          channelId: readDiscordChannelId(data),
          messageId: readDiscordMessageId(data),
        });
      })
      .catch((err: unknown) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
      });
  }
}

export class DiscordReconnectBackfillReadyListener extends ReadyListener {
  constructor(
    private params: {
      accountId: string;
      messageHandler: DiscordMessageHandler;
      botUserId?: string;
      logger?: Logger;
      onEvent?: () => void;
    },
  ) {
    super();
  }

  async handle(_data: unknown, client: Client) {
    void backfillRecentDiscordInboundMessages({
      accountId: this.params.accountId,
      client,
      messageHandler: this.params.messageHandler,
      botUserId: this.params.botUserId,
      logger: this.params.logger,
      onEvent: this.params.onEvent,
    });
  }
}

export class DiscordReconnectBackfillResumedListener extends ResumedListener {
  constructor(
    private params: {
      accountId: string;
      messageHandler: DiscordMessageHandler;
      botUserId?: string;
      logger?: Logger;
      onEvent?: () => void;
    },
  ) {
    super();
  }

  async handle(_data: unknown, client: Client) {
    void backfillRecentDiscordInboundMessages({
      accountId: this.params.accountId,
      client,
      messageHandler: this.params.messageHandler,
      botUserId: this.params.botUserId,
      logger: this.params.logger,
      onEvent: this.params.onEvent,
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
      .catch((err: unknown) => {
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
