// Discord plugin module implements listeners behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import {
  type Client,
  InteractionCreateListener,
  MessageCreateListener,
  PresenceUpdateListener,
  ReadyListener,
  ThreadUpdateListener,
} from "../internal/discord.js";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";
export { DiscordReactionListener, DiscordReactionRemoveListener } from "./listeners.reactions.js";
import { type DiscordGuildEntryResolved, resolveDiscordGuildEntry } from "./allow-list.js";
import { clearPresences, setPresence } from "./presence-cache.js";
import { openDiscordPresenceCooldownStore } from "./presence-cooldown-store.js";
import {
  DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
  isDiscordOfflineStatus,
  isDiscordOnlineStatus,
  resolveDiscordOnlinePresenceEvent,
} from "./presence-events.js";
import { DiscordOfflinePresenceCache } from "./presence-transition-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";

type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];
type DiscordInteractionEvent = Parameters<InteractionCreateListener["handle"]>[0];

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
      .catch((err: unknown) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
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
  private readonly offlinePresence = new DiscordOfflinePresenceCache();
  private readonly pendingByGuildUser = new Map<string, Promise<void>>();
  private startedAtMs: number;
  private gatewayGeneration = 0;
  private readonly cooldownStore: PluginStateSyncKeyedStore<number>;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      logger?: Logger;
      accountId: string;
      botUserId?: string;
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      nowMs?: () => number;
      cooldownStore?: PluginStateSyncKeyedStore<number>;
    },
  ) {
    super();
    this.startedAtMs = params.nowMs?.() ?? Date.now();
    this.cooldownStore = params.cooldownStore ?? openDiscordPresenceCooldownStore();
  }

  async handle(data: PresenceUpdateEvent, client: Client) {
    const userId = data.user?.id;
    if (!userId) {
      return;
    }
    setPresence(this.params.accountId, userId, data);
    const presenceKey = `${this.params.accountId}:${data.guild_id}:${userId}`;
    const gatewayGeneration = this.gatewayGeneration;
    const previousRun = this.pendingByGuildUser.get(presenceKey) ?? Promise.resolve();
    const run = previousRun.then(
      () => this.handleSerial(data, client, userId, presenceKey, gatewayGeneration),
      () => this.handleSerial(data, client, userId, presenceKey, gatewayGeneration),
    );
    this.pendingByGuildUser.set(presenceKey, run);
    try {
      await run;
    } catch (err) {
      const logger = this.params.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    } finally {
      if (this.pendingByGuildUser.get(presenceKey) === run) {
        this.pendingByGuildUser.delete(presenceKey);
      }
    }
  }

  resetGatewaySession(): void {
    this.gatewayGeneration += 1;
    this.startedAtMs = this.params.nowMs?.() ?? Date.now();
    this.offlinePresence.clear();
    this.pendingByGuildUser.clear();
    clearPresences(this.params.accountId);
  }

  private async handleSerial(
    data: PresenceUpdateEvent,
    client: Client,
    userId: string,
    presenceKey: string,
    gatewayGeneration: number,
  ) {
    if (gatewayGeneration !== this.gatewayGeneration) {
      return;
    }
    const config = resolveDiscordGuildEntry({
      guildId: data.guild_id,
      guildEntries: this.params.guildEntries,
    })?.presenceEvents;
    if (
      !config ||
      config.enabled === false ||
      (config.users !== undefined && !config.users.includes(userId))
    ) {
      return;
    }

    const nowMs = this.params.nowMs?.() ?? Date.now();
    const hasOfflineBaseline = this.offlinePresence.hasRecentOffline(presenceKey, nowMs);
    const presenceEvent = resolveDiscordOnlinePresenceEvent({
      config,
      data,
      hadOfflineBaseline: hasOfflineBaseline,
      botUserId: this.params.botUserId,
      startedAtMs: this.startedAtMs,
      nowMs,
      lastEmittedAtMs: this.cooldownStore.lookup(presenceKey),
    });
    if (!presenceEvent) {
      if (isDiscordOfflineStatus(data.status)) {
        this.offlinePresence.observeOffline(presenceKey, nowMs);
      } else if (isDiscordOnlineStatus(data.status)) {
        this.offlinePresence.delete(presenceKey);
      }
      return;
    }

    // Reserve before the partial-user lookup. Per-user serialization and rollback preserve the
    // transition across transient Discord failures without allowing concurrent duplicate wakes.
    this.cooldownStore.register(presenceKey, nowMs, {
      ttlMs: DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
    });
    let queued = false;
    try {
      if (data.user.bot === undefined && (await client.fetchUser(userId)).bot === true) {
        this.offlinePresence.delete(presenceKey);
        this.cooldownStore.delete(presenceKey);
        return;
      }
      if (gatewayGeneration !== this.gatewayGeneration) {
        if (this.cooldownStore.lookup(presenceKey) === nowMs) {
          this.cooldownStore.delete(presenceKey);
        }
        return;
      }
      const route = resolveAgentRoute({
        cfg: this.params.cfg,
        channel: "discord",
        accountId: this.params.accountId,
        guildId: data.guild_id,
        peer: { kind: "channel", id: presenceEvent.channelId },
      });
      queued = enqueueSystemEvent(presenceEvent.text, {
        sessionKey: route.sessionKey,
        contextKey: `discord:presence-online:${this.params.accountId}:${data.guild_id}:${userId}`,
        deliveryContext: {
          channel: "discord",
          to: `channel:${presenceEvent.channelId}`,
          accountId: this.params.accountId,
        },
      });
      if (!queued) {
        this.cooldownStore.delete(presenceKey);
        return;
      }
      this.offlinePresence.delete(presenceKey);
      requestHeartbeat({
        source: "notifications-event",
        intent: "immediate",
        reason: "wake",
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        heartbeat: {
          target: "discord",
          to: `channel:${presenceEvent.channelId}`,
          accountId: this.params.accountId,
        },
      });
    } catch (err) {
      if (!queued && this.cooldownStore.lookup(presenceKey) === nowMs) {
        this.cooldownStore.delete(presenceKey);
      }
      throw err;
    }
  }
}

export class DiscordPresenceReadyListener extends ReadyListener {
  constructor(private readonly presenceListener: DiscordPresenceListener) {
    super();
  }

  handle(): void {
    this.presenceListener.resetGatewaySession();
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
