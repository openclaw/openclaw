import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import {
  type Client,
  type DiscordMessageDispatchData,
  GuildCreateListener,
  GuildDeleteListener,
  InteractionCreateListener,
  MessageCreateListener,
  PresenceUpdateListener,
  ReadyListener,
  ThreadDeleteListener,
  ThreadUpdateListener,
} from "../internal/discord.js";
import { canViewDiscordGuildChannel } from "../send.permissions.js";
import { type DiscordGuildEntryResolved, resolveDiscordGuildEntry } from "./allow-list.js";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import { clearPresences, setPresence } from "./presence-cache.js";
import { openDiscordPresenceCooldownStore } from "./presence-cooldown-store.js";
import {
  DiscordPresenceEmissionGate,
  resolveDiscordPresenceGateOptions,
} from "./presence-emission-gate.js";
import {
  DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
  isDiscordOfflineStatus,
  isDiscordOnlineStatus,
  resolveDiscordOnlinePresenceEvent,
} from "./presence-events.js";
import { DiscordPresenceBaselineCache } from "./presence-transition-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { getThreadBindingManager } from "./thread-bindings.manager.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";
export { DiscordReactionListener, DiscordReactionRemoveListener } from "./listeners.reactions.js";

type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

type DiscordRawMessageEvent = Parameters<MessageCreateListener["handle"]>[0];
export type DiscordMessageEvent = DiscordMessageDispatchData;
type DiscordInteractionEvent = Parameters<InteractionCreateListener["handle"]>[0];

export type DiscordMessageHandler = (
  data: DiscordRawMessageEvent,
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

  async handle(data: DiscordRawMessageEvent, client: Client) {
    this.onEvent?.();
    // This awaits only the durable append. Agent dispatch remains detached behind
    // the ingress drain, so later gateway events never wait for a model turn.
    try {
      await this.handler(data, client);
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord handler failed: ${String(err)}`));
    }
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
      .then(() => client.handleInteraction(data))
      .catch((err: unknown) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord interaction handler failed: ${String(err)}`));
      });
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];
type GuildCreateEvent = Parameters<GuildCreateListener["handle"]>[0];
type GuildDeleteEvent = Parameters<GuildDeleteListener["handle"]>[0];
type GuildPresenceState = { available: boolean; inferUnknownAsNewlyAvailable: boolean };

export class DiscordPresenceListener extends PresenceUpdateListener {
  private readonly presenceBaseline: DiscordPresenceBaselineCache;
  // Retain FIFO across reconnects; each latest chain also settles its predecessors at shutdown.
  private readonly pendingByGuildUser = new Map<string, Promise<void>>();
  private readonly pendingGuildSeeds = new Map<string, Promise<void>>();
  private readonly guildPresenceState = new Map<string, GuildPresenceState>();
  private hasGatewayReset = false;
  private stopped = false;
  private readonly cooldownStore: PluginStateKeyedStore<number>;
  private readonly emissionGate: DiscordPresenceEmissionGate;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      logger?: Logger;
      accountId: string;
      botUserId?: string;
      readPolicy?: DiscordLivePolicyReader;
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      nowMs?: () => number;
      cooldownStore?: PluginStateKeyedStore<number>;
      presenceBaseline?: DiscordPresenceBaselineCache;
      emissionGate?: DiscordPresenceEmissionGate;
    },
  ) {
    super();
    this.cooldownStore = params.cooldownStore ?? openDiscordPresenceCooldownStore();
    this.presenceBaseline = params.presenceBaseline ?? new DiscordPresenceBaselineCache();
    this.emissionGate = params.emissionGate ?? new DiscordPresenceEmissionGate();
  }

  async seedGuildSnapshot(data: GuildCreateEvent): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.guildPresenceState.set(data.id, {
      available: data.unavailable !== true,
      inferUnknownAsNewlyAvailable: false,
    });
    this.presenceBaseline.clearScope(data.id);
    // Cache metadata before awaiting greeting policy so updates and READY retain dispatch order.
    if (data.unavailable !== true && "presences" in data && Array.isArray(data.presences)) {
      for (const presence of data.presences) {
        const userId = presence.user?.id;
        if (userId) {
          setPresence(this.params.accountId, userId, { ...presence, guild_id: data.id });
        }
      }
    }
    if (!this.params.readPolicy) {
      this.seedGuildSnapshotWithPolicy(data, this.params.guildEntries);
      return;
    }
    const seed = this.params.readPolicy().then((policy) => {
      this.seedGuildSnapshotWithPolicy(data, policy.guildEntries);
    });
    this.pendingGuildSeeds.set(data.id, seed);
    try {
      await seed;
    } finally {
      if (this.pendingGuildSeeds.get(data.id) === seed) {
        this.pendingGuildSeeds.delete(data.id);
      }
    }
  }

  private seedGuildSnapshotWithPolicy(
    data: GuildCreateEvent,
    guildEntries: Record<string, DiscordGuildEntryResolved> | undefined,
  ): void {
    const config = resolveDiscordGuildEntry({
      guildId: data.id,
      guildEntries,
    })?.presenceEvents;
    const state = this.guildPresenceState.get(data.id);
    if (!state || !config || config.enabled === false) {
      return;
    }
    const keyPrefix = `${this.params.accountId}:${data.id}:`;
    if (data.unavailable === true || !("presences" in data) || !Array.isArray(data.presences)) {
      return;
    }
    // Discord documents snapshots above 75,000 members as partial. Unknown members from those
    // guilds stay suppressed until an explicit offline update establishes the transition.
    state.inferUnknownAsNewlyAvailable = data.member_count <= 75_000;
    for (const presence of data.presences) {
      const userId = presence.user?.id;
      if (!userId || (config.users !== undefined && !config.users.includes(userId))) {
        continue;
      }
      this.recordPresenceBaseline(data.id, `${keyPrefix}${userId}`, presence.status);
    }
  }

  async handle(data: PresenceUpdateEvent, client: Client) {
    const userId = data.user?.id;
    if (!userId || this.stopped) {
      return;
    }
    setPresence(this.params.accountId, userId, data);
    const pendingSeed = this.pendingGuildSeeds.get(data.guild_id);
    if (pendingSeed) {
      await pendingSeed;
      if (this.stopped) {
        return;
      }
    }
    const presenceKey = `${this.params.accountId}:${data.guild_id}:${userId}`;
    const previousRun = this.pendingByGuildUser.get(presenceKey) ?? Promise.resolve();
    const handle = () => this.handleSerial(data, client, userId, presenceKey);
    const run = previousRun.then(handle, handle);
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

  async stop(): Promise<void> {
    this.stopped = true;
    this.resetGatewaySession();
    await Promise.allSettled(this.pendingByGuildUser.values());
  }

  resetGatewaySession(): void {
    this.hasGatewayReset = true;
    // A READY event starts a new Gateway session and rebuilds guild presence state. Hold emission
    // during that rebuild so the re-observation burst cannot wake the agent per member.
    this.emissionGate.noteGatewaySessionReset(this.params.nowMs?.() ?? Date.now());
    this.presenceBaseline.clear();
    this.guildPresenceState.clear();
    this.pendingGuildSeeds.clear();
    clearPresences(this.params.accountId);
  }

  invalidateGuild(guildId: string): void {
    this.pendingGuildSeeds.delete(guildId);
    this.guildPresenceState.set(guildId, {
      available: false,
      inferUnknownAsNewlyAvailable: false,
    });
    this.presenceBaseline.clearScope(guildId);
  }

  private async handleSerial(
    data: PresenceUpdateEvent,
    client: Client,
    userId: string,
    presenceKey: string,
  ) {
    if (this.stopped) {
      return;
    }
    const policy = await this.params.readPolicy?.();
    const cfg = policy?.cfg ?? this.params.cfg;
    const config = resolveDiscordGuildEntry({
      guildId: data.guild_id,
      guildEntries: policy ? policy.guildEntries : this.params.guildEntries,
    })?.presenceEvents;
    if (!config || config.enabled === false) {
      return;
    }
    // Filter before every baseline read or write. Excluded traffic must not consume bounded state.
    if (config.users !== undefined && !config.users.includes(userId)) {
      return;
    }

    const lastEmittedAtMs = await this.cooldownStore.lookup(presenceKey);
    const nowMs = this.params.nowMs?.() ?? Date.now();
    const presenceScope = data.guild_id;
    // A complete GUILD_CREATE lists currently online members. A later first-seen member is newly
    // available to the guild, but may have joined after the snapshot; never assert prior offline.
    const availabilityKind = this.presenceBaseline.isOffline(presenceScope, presenceKey)
      ? "observed-offline"
      : this.guildPresenceState.get(data.guild_id)?.inferUnknownAsNewlyAvailable === true &&
          !this.presenceBaseline.isOnline(presenceScope, presenceKey)
        ? "first-seen-after-snapshot"
        : null;
    const presenceEvent = resolveDiscordOnlinePresenceEvent({
      config,
      data,
      availabilityKind,
      botUserId: this.params.botUserId,
      nowMs,
      lastEmittedAtMs,
    });
    if (!presenceEvent) {
      this.recordPresenceBaseline(data.guild_id, presenceKey, data.status);
      return;
    }

    const gateOptions = resolveDiscordPresenceGateOptions(config);
    const logSuppression = (gate: { shouldLog: boolean; reason: string }) => {
      if (gate.shouldLog) {
        (this.params.logger ?? discordEventQueueLog).info("Discord presence events suppressed", {
          reason: gate.reason,
          accountId: this.params.accountId,
          guildId: data.guild_id,
        });
      }
    };
    const reconnectGate = this.emissionGate.evaluateReconnectWindow(nowMs, gateOptions);
    if (!reconnectGate.allowed) {
      logSuppression(reconnectGate);
      // Mark online so the member is not re-greeted at window end; a later observed
      // offline-to-online transition still emits normally.
      this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
      return;
    }

    // Reserve before Discord REST lookups so a presence storm cannot bypass the burst cap by
    // filling the permission queue. Release every unqueued attempt; commit only after enqueue.
    const burstNowMs = this.params.nowMs?.() ?? Date.now();
    const burstGate = this.emissionGate.reserveBurst(data.guild_id, burstNowMs, gateOptions);
    if (!burstGate.allowed) {
      logSuppression(burstGate);
      if (burstGate.reason === "burst-pending") {
        // Pending permission checks cap REST concurrency, but they are not emitted greetings.
        // Keep this member retryable after a lookup settles instead of advancing its baseline.
        return;
      }
      this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
      return;
    }
    const burstReservation = burstGate.reservation;
    let burstCommitted = false;
    let cooldownReserved = false;
    try {
      const fetchedUserIsBot =
        data.user.bot === undefined && (await client.fetchUser(userId)).bot === true;
      if (fetchedUserIsBot) {
        this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
        return;
      }
      const canViewTargetChannel = await canViewDiscordGuildChannel(
        data.guild_id,
        presenceEvent.channelId,
        userId,
        {
          cfg,
          accountId: this.params.accountId,
          rest: client.rest,
        },
      );
      if (!canViewTargetChannel) {
        // Presence is guild-wide. Require target-channel visibility so private channel greetings
        // cannot be triggered by unrelated guild members.
        this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
        return;
      }
      const route = resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: this.params.accountId,
        guildId: data.guild_id,
        peer: { kind: "channel", id: presenceEvent.channelId },
      });

      try {
        cooldownReserved = await this.cooldownStore.registerIfAbsent(presenceKey, nowMs, {
          ttlMs: DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
        });
        if (!cooldownReserved) {
          // Another live listener won the durable claim while this one awaited Discord. Treat the
          // member as online locally so overlapping provider generations cannot retry the greeting.
          this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
          return;
        }
      } catch (err) {
        const logger = this.params.logger ?? discordEventQueueLog;
        logger.warn(danger(`discord presence cooldown persistence failed: ${String(err)}`));
        return;
      }

      if (
        this.stopped ||
        policy?.isCurrent() === false ||
        !(this.guildPresenceState.get(data.guild_id)?.available ?? !this.hasGatewayReset)
      ) {
        return;
      }
      const currentReconnectGate = this.emissionGate.evaluateReconnectWindow(
        this.params.nowMs?.() ?? Date.now(),
        gateOptions,
      );
      if (!currentReconnectGate.allowed) {
        logSuppression(currentReconnectGate);
        this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
        return;
      }
      const queued = enqueueRoutedSystemEvent(presenceEvent.text, route, {
        contextKey: `discord:presence-online:${this.params.accountId}:${data.guild_id}:${userId}`,
        deliveryContext: {
          channel: "discord",
          to: `channel:${presenceEvent.channelId}`,
          accountId: this.params.accountId,
        },
      });
      if (!queued) {
        return;
      }
      this.emissionGate.commitBurst(burstReservation, this.params.nowMs?.() ?? Date.now());
      burstCommitted = true;
      this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
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
    } finally {
      if (!burstCommitted) {
        this.emissionGate.releaseBurst(data.guild_id, burstReservation);
      }
      if (cooldownReserved && !burstCommitted) {
        await this.cooldownStore.deleteIfEqual?.(presenceKey, nowMs);
      }
    }
  }

  private recordPresenceBaseline(guildId: string, key: string, status: string | undefined): void {
    const evictedGuildId = isDiscordOfflineStatus(status)
      ? this.presenceBaseline.observeOffline(guildId, key)
      : isDiscordOnlineStatus(status)
        ? this.presenceBaseline.observeOnline(guildId, key)
        : undefined;
    if (!evictedGuildId) {
      return;
    }
    // Only the guild whose authoritative marker was shed loses snapshot-absence evidence.
    const state = this.guildPresenceState.get(evictedGuildId);
    if (state) {
      state.inferUnknownAsNewlyAvailable = false;
    }
  }
}

export class DiscordPresenceGuildCreateListener extends GuildCreateListener {
  constructor(private readonly presenceListener: DiscordPresenceListener) {
    super();
  }

  async handle(data: GuildCreateEvent): Promise<void> {
    await this.presenceListener.seedGuildSnapshot(data);
  }
}

export class DiscordPresenceGuildDeleteListener extends GuildDeleteListener {
  constructor(private readonly presenceListener: DiscordPresenceListener) {
    super();
  }

  handle(data: GuildDeleteEvent): void {
    this.presenceListener.invalidateGuild(data.id);
  }
}

class DiscordSessionResetListener extends ReadyListener {
  constructor(private readonly owner: { resetGatewaySession(): void }) {
    super();
  }

  handle(): void {
    this.owner.resetGatewaySession();
  }
}

export class DiscordPresenceReadyListener extends DiscordSessionResetListener {}
export class DiscordThreadReadyListener extends DiscordSessionResetListener {}

type ThreadUpdateEvent = Parameters<ThreadUpdateListener["handle"]>[0];
const DISCORD_THREAD_REJOIN_CLAIM_MAX_ENTRIES = 10_000;

export class DiscordThreadUpdateListener extends ThreadUpdateListener {
  private readonly rejoinClaims = new Map<string, true>();

  constructor(
    private cfg: OpenClawConfig,
    private logger?: Logger,
  ) {
    super();
  }

  resetGatewaySession(): void {
    this.rejoinClaims.clear();
  }

  async handle(data: ThreadUpdateEvent, client: Client) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: async () => {
        const threadId = "id" in data && typeof data.id === "string" ? data.id : undefined;
        if (!threadId) {
          return;
        }
        const logger = this.logger ?? discordEventQueueLog;
        if (isThreadArchived(data)) {
          this.rejoinClaims.delete(threadId);
          const count = await closeDiscordThreadSessions({
            cfg: this.cfg,
            threadId,
          });
          if (count > 0) {
            logger.info("Discord thread archived — reset sessions", { threadId, count });
          }
          return;
        }
        if (this.rejoinClaims.has(threadId)) {
          return;
        }

        // Claim before awaiting REST because listener jobs may overlap. Keep the newest claims
        // bounded across long-lived gateway sessions so ordinary updates cannot grow memory forever.
        this.rejoinClaims.set(threadId, true);
        pruneMapToMaxSize(this.rejoinClaims, DISCORD_THREAD_REJOIN_CLAIM_MAX_ENTRIES);
        try {
          await client.rest.put(`/channels/${threadId}/thread-members/@me`);
          logger.info("Discord active thread — rejoined thread", { threadId });
        } catch (err) {
          this.rejoinClaims.delete(threadId);
          logger.warn(danger(`discord thread rejoin failed: ${String(err)}`), { threadId });
        }
      },
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-update handler failed: ${String(err)}`));
      },
    });
  }
}

type ThreadDeleteEvent = Parameters<ThreadDeleteListener["handle"]>[0];

export class DiscordThreadDeleteListener extends ThreadDeleteListener {
  constructor(
    private cfg: OpenClawConfig,
    private accountId: string,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: ThreadDeleteEvent) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: async () => {
        const threadId = data.id;
        await getThreadBindingManager(this.accountId)?.unbindThread({
          threadId,
          reason: "thread-delete",
          sendFarewell: false,
        });
        const count = await closeDiscordThreadSessions({
          cfg: this.cfg,
          threadId,
        });
        if (count > 0) {
          const logger = this.logger ?? discordEventQueueLog;
          logger.info("Discord thread deleted — reset sessions", { threadId, count });
        }
      },
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-delete handler failed: ${String(err)}`));
      },
    });
  }
}
