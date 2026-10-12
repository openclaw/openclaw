import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  getGuildVoiceState,
  isUnknownDiscordVoiceStateError,
  type Client,
} from "../internal/discord.js";
import { DECRYPT_FAILURE_WINDOW_MS } from "./receive-recovery.js";
import { logVoiceVerbose, type VoiceOperationResult, type VoiceSessionEntry } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const FOLLOW_USERS_RECONCILE_INTERVAL_MS = 10_000;
const FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN = 4;
const FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN = 32;

export type VoiceChannelResidency = {
  guildId: string;
  channelId: string;
  whenOccupied?: boolean;
};

export function normalizeVoiceChannelResidencies(
  entries: Array<{ guildId?: string; channelId?: string; whenOccupied?: boolean }> | undefined,
): VoiceChannelResidency[] {
  return Array.from(entries ?? [], (entry) => {
    const guildId = entry.guildId?.trim();
    const channelId = entry.channelId?.trim();
    return guildId && channelId
      ? [{ guildId, channelId, ...(entry.whenOccupied === true ? { whenOccupied: true } : {}) }]
      : [];
  }).flat();
}

function normalizeDiscordUserIds(entries: string[] | undefined): Set<string> {
  return new Set(
    Array.from(entries ?? [], (entry) =>
      entry
        .trim()
        .replace(/^discord:/, "")
        .replace(/^user:/, "")
        .trim(),
    ).filter(Boolean),
  );
}

function logFollowUserReconcileVerbose(reason: string, message: string): void {
  if (reason === "interval") {
    logger.trace(`discord voice: ${message}`);
    return;
  }
  logVoiceVerbose(message);
}

export class DiscordVoiceFollowing {
  private readonly followUserIds: Set<string>;
  readonly followedUserChannels = new Map<string, VoiceChannelResidency>();
  private readonly followedVoiceGuilds = new Set<string>();
  private readonly scheduler: PluginServiceSchedulerV1;
  private followUsersReconcileTask: Promise<void> | null = null;
  private reconcileCursor = 0;

  constructor(
    private readonly params: {
      scheduler: PluginServiceSchedulerV1;
      allowedChannels: VoiceChannelResidency[] | null;
      autoJoinChannels: VoiceChannelResidency[];
      botUserId: () => string | undefined;
      client: Client;
      deleteRecoveryAttempt: (guildId: string) => void;
      discordConfig: DiscordAccountConfig;
      stopTransport: (guildId: string) => Promise<void>;
      getRecoveryAttempt: (guildId: string) => number | undefined;
      getSession: (guildId: string) => VoiceSessionEntry | undefined;
      hasVoiceLifecycle: (guildId: string) => boolean;
      isAllowedVoiceChannel: (entry: VoiceChannelResidency) => boolean;
      join: (
        entry: VoiceChannelResidency,
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      leave: (
        entry: { guildId: string },
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      listSessions: () => Iterable<VoiceSessionEntry>;
      voiceEnabled: boolean;
    },
  ) {
    this.scheduler = params.scheduler.scope();
    this.followUserIds =
      params.discordConfig.voice?.followUsersEnabled !== false
        ? normalizeDiscordUserIds(params.discordConfig.voice?.followUsers)
        : new Set();
  }

  isFollowedUser(userId: string): boolean {
    return this.followUserIds.has(userId);
  }

  async startReconciliation(): Promise<void> {
    if (this.followUserIds.size === 0 || this.scheduler.signal.aborted) {
      return;
    }
    this.scheduler.schedule({
      id: "follow-users",
      mode: "earliest",
      delayMs: FOLLOW_USERS_RECONCILE_INTERVAL_MS,
      everyMs: FOLLOW_USERS_RECONCILE_INTERVAL_MS,
      run: () =>
        this.reconcileFollowedUsers("interval").catch((err: unknown) => {
          logger.warn(
            `discord voice: follow user reconciliation failed: ${formatErrorMessage(err)}`,
          );
        }),
    });
    await this.reconcileFollowedUsers("startup");
  }

  async handleBotVoiceStateUpdate(params: {
    guildId: string;
    channelId: string | undefined;
  }): Promise<void> {
    const { guildId, channelId } = params;
    if (!channelId) {
      return;
    }
    const existing = this.params.getSession(guildId);
    if (this.params.isAllowedVoiceChannel({ guildId, channelId })) {
      if (existing && existing.channelId !== channelId) {
        logger.warn(
          `discord voice: bot moved to allowed channel guild=${guildId} from=${existing.channelId} to=${channelId}; rebuilding voice session`,
        );
        await this.params.join(
          { guildId, channelId },
          { preserveFollowState: this.isFollowOwnedGuild(guildId) },
        );
      }
      return;
    }

    logger.warn(
      `discord voice: bot moved to non-allowed channel guild=${guildId} channel=${channelId}; leaving`,
    );
    if (existing) {
      await this.params.leave({ guildId });
    } else {
      await this.params.stopTransport(guildId);
    }

    const target = this.resolveVoiceResidencyTarget(guildId);
    if (target) {
      logger.warn(
        `discord voice: rejoining allowed voice channel guild=${guildId} channel=${target.channelId}`,
      );
      await this.params.join(target);
    }
  }

  async handleFollowedUserVoiceStateUpdate(params: {
    guildId: string;
    channelId: string | undefined;
    userId: string;
  }): Promise<void> {
    if (!this.params.voiceEnabled || this.scheduler.signal.aborted) {
      return;
    }
    const { guildId, channelId, userId } = params;
    const followKey = `${guildId}:${userId}`;
    const previousFollowedChannelId = this.followedUserChannels.get(followKey)?.channelId;
    const existing = this.params.getSession(guildId);
    const wasFollowedVoiceSession =
      this.followedUserChannels.has(followKey) || this.followedVoiceGuilds.has(guildId);
    if (!channelId || !this.params.isAllowedVoiceChannel({ guildId, channelId })) {
      this.followedUserChannels.delete(followKey);
      if (channelId) {
        logger.warn(
          `discord voice: followed user joined non-allowed channel guild=${guildId} user=${userId} channel=${channelId}; ignoring`,
        );
      }
      if (existing && wasFollowedVoiceSession && !this.hasFollowedUserInChannel(existing)) {
        await this.handoffToAnotherFollowedUserOrLeave({
          guildId,
          userId,
          existing,
          reason: channelId ? "joined non-allowed channel" : "disconnected",
        });
      } else if (
        !channelId &&
        !existing &&
        wasFollowedVoiceSession &&
        this.params.hasVoiceLifecycle(guildId)
      ) {
        await this.params.leave({ guildId });
      }
      return;
    }
    const followedChannel = { guildId, channelId };
    this.followedUserChannels.set(followKey, followedChannel);
    if (existing?.channelId === channelId) {
      this.followedVoiceGuilds.add(guildId);
      return;
    }
    const recoveryAttemptAt = this.params.getRecoveryAttempt(guildId);
    if (!existing && previousFollowedChannelId === channelId && recoveryAttemptAt !== undefined) {
      if (Date.now() - recoveryAttemptAt < DECRYPT_FAILURE_WINDOW_MS) {
        logger.warn(
          `discord voice: automatic follow suppressed during DAVE recovery cooldown guild=${guildId} channel=${channelId}; retry /vc join after the voice gateway recovers`,
        );
        return;
      }
      this.params.deleteRecoveryAttempt(guildId);
    }
    logger.info(
      `discord voice: following user guild=${guildId} user=${userId} channel=${channelId}`,
    );
    const result = await this.params.join({ guildId, channelId }, { preserveFollowState: true });
    if (this.followedUserChannels.get(followKey) !== followedChannel) {
      return;
    }
    if (!result.ok) {
      const current = this.params.getSession(guildId);
      if (current?.channelId === channelId) {
        this.followedVoiceGuilds.add(guildId);
      } else {
        this.followedUserChannels.delete(followKey);
      }
      logger.warn(
        `discord voice: failed to follow user guild=${guildId} user=${userId} channel=${channelId}: ${result.message}`,
      );
      return;
    }
    this.followedVoiceGuilds.add(guildId);
  }

  async destroy(): Promise<void> {
    await this.scheduler.stop();
    await this.followUsersReconcileTask;
    this.followedUserChannels.clear();
    this.followedVoiceGuilds.clear();
  }

  isFollowOwnedGuild(guildId: string): boolean {
    return (
      this.followedVoiceGuilds.has(guildId) ||
      Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId)
    );
  }

  clearFollowedGuild(guildId: string): void {
    this.followedVoiceGuilds.delete(guildId);
    for (const [key, entry] of this.followedUserChannels.entries()) {
      if (entry.guildId === guildId) {
        this.followedUserChannels.delete(key);
      }
    }
  }

  private resolveFollowGuildIds(): string[] {
    const guildIds = new Set(
      Object.keys(this.params.discordConfig.guilds ?? {})
        .map((guildId) => guildId.trim())
        .filter(Boolean),
    );
    for (const entries of [
      this.params.autoJoinChannels,
      this.params.allowedChannels ?? [],
      this.params.listSessions(),
    ]) {
      for (const entry of entries) {
        guildIds.add(entry.guildId);
      }
    }
    return Array.from(guildIds);
  }

  private async reconcileFollowedUsers(reason: string): Promise<void> {
    if (this.followUserIds.size === 0 || this.scheduler.signal.aborted) {
      return;
    }
    if (this.followUsersReconcileTask) {
      return this.followUsersReconcileTask;
    }
    this.followUsersReconcileTask = this.runFollowedUsersReconcile(reason).finally(() => {
      this.followUsersReconcileTask = null;
    });
    return this.followUsersReconcileTask;
  }

  private async runFollowedUsersReconcile(reason: string): Promise<void> {
    if (this.scheduler.signal.aborted) {
      return;
    }
    const guildIds = this.resolveFollowGuildIds();
    if (guildIds.length === 0) {
      logVoiceVerbose(
        `follow user reconcile skipped reason=${reason}: no Discord guild ids are configured`,
      );
      return;
    }
    logFollowUserReconcileVerbose(
      reason,
      `follow user reconcile reason=${reason}: ${this.followUserIds.size} users across ${guildIds.length} guilds`,
    );
    const userIds = [...this.followUserIds];
    const slotsPerGuild = userIds.length + (this.params.botUserId() ? 1 : 0);
    const totalSlots = guildIds.length * slotsPerGuild;
    const start = this.reconcileCursor % totalSlots;
    const visitedGuilds = new Set<string>();

    // One cursor walks users and then the bot in each guild. Large lists converge
    // over multiple runs without separate user, guild, and bot scheduling state.
    for (
      let offset = 0;
      offset < Math.min(totalSlots, FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN);
      offset += 1
    ) {
      if (this.scheduler.signal.aborted) {
        return;
      }
      const slot = (start + offset) % totalSlots;
      const guildId = expectDefined(
        guildIds[Math.floor(slot / slotsPerGuild)],
        "voice reconciliation guild",
      );
      if (
        !visitedGuilds.has(guildId) &&
        visitedGuilds.size >= FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN
      ) {
        break;
      }
      visitedGuilds.add(guildId);
      this.reconcileCursor = (slot + 1) % totalSlots;
      const userIndex = slot % slotsPerGuild;
      if (userIndex === userIds.length) {
        await this.disconnectStaleFollowedBotVoiceState({ guildId, reason });
        continue;
      }
      const userId = expectDefined(userIds[userIndex], "voice reconciliation user");
      const voiceState = await this.readReconcileVoiceState(guildId, userId, reason);
      if (this.scheduler.signal.aborted) {
        return;
      }
      if (voiceState !== "transient-error") {
        await this.handleFollowedUserVoiceStateUpdate({
          guildId,
          channelId: voiceState?.channel_id?.trim(),
          userId,
        });
      }
    }
  }

  private hasFollowedUserInChannel(entry: VoiceChannelResidency): boolean {
    return Array.from(this.followedUserChannels.values()).some(
      (candidate) => candidate.guildId === entry.guildId && candidate.channelId === entry.channelId,
    );
  }

  private resolveFollowedUserHandoffTarget(
    guildId: string,
    currentChannelId: string,
  ): VoiceChannelResidency | null {
    for (const entry of this.followedUserChannels.values()) {
      if (
        entry.guildId === guildId &&
        entry.channelId !== currentChannelId &&
        this.params.isAllowedVoiceChannel(entry)
      ) {
        return entry;
      }
    }
    return null;
  }

  private async handoffToAnotherFollowedUserOrLeave(params: {
    guildId: string;
    userId: string;
    existing: VoiceChannelResidency;
    reason: string;
  }): Promise<void> {
    const target = this.resolveFollowedUserHandoffTarget(params.guildId, params.existing.channelId);
    if (target) {
      logger.info(
        `discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; moving to remaining followed user channel=${target.channelId}`,
      );
      const result = await this.params.join(target, { preserveFollowState: true });
      if (result.ok) {
        this.followedVoiceGuilds.add(params.guildId);
      } else {
        logger.warn(
          `discord voice: failed to hand off followed user session guild=${params.guildId} channel=${target.channelId}: ${result.message}`,
        );
        this.clearFollowedGuild(params.guildId);
        await this.params.leave({ guildId: params.guildId });
      }
      return;
    }
    logger.info(
      `discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; leaving channel=${params.existing.channelId}`,
    );
    await this.params.leave({ guildId: params.guildId });
  }

  private async disconnectStaleFollowedBotVoiceState(params: {
    guildId: string;
    reason: string;
  }): Promise<void> {
    if (this.scheduler.signal.aborted) {
      return;
    }
    const { guildId, reason } = params;
    if (Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId)) {
      return;
    }
    const existing = this.params.getSession(guildId);
    if (existing) {
      if (this.followedVoiceGuilds.has(guildId)) {
        logger.info(
          `discord voice: follow reconcile leaving local session guild=${guildId} channel=${existing.channelId} reason=${reason}`,
        );
        await this.params.leave({ guildId });
      }
      return;
    }
    const botUserId = this.params.botUserId();
    if (!botUserId) {
      return;
    }
    const botVoiceState = await this.readReconcileVoiceState(guildId, botUserId, reason, true);
    if (this.scheduler.signal.aborted || botVoiceState === "transient-error") {
      return;
    }
    const botChannelId = botVoiceState?.channel_id?.trim();
    if (!botChannelId) {
      return;
    }
    const voicePlugin = this.params.client.getPlugin("voice");
    const gateway = voicePlugin?.getGateway(guildId);
    if (!gateway) {
      logger.warn(
        `discord voice: follow reconcile cannot disconnect stale bot voice state guild=${guildId} channel=${botChannelId}; gateway unavailable`,
      );
      return;
    }
    logger.info(
      `discord voice: follow reconcile disconnecting stale bot voice state guild=${guildId} channel=${botChannelId} reason=${reason}`,
    );
    gateway.updateVoiceState({
      guild_id: guildId,
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    });
  }

  private resolveVoiceResidencyTarget(guildId: string): VoiceChannelResidency | null {
    const autoJoinTarget = this.params.autoJoinChannels.findLast(
      (entry) => entry.guildId === guildId,
    );
    if (autoJoinTarget?.whenOccupied) {
      return null;
    }
    if (autoJoinTarget && this.params.isAllowedVoiceChannel(autoJoinTarget)) {
      return autoJoinTarget;
    }
    if (this.params.allowedChannels === null) {
      return null;
    }
    const guildAllowed = this.params.allowedChannels.filter((entry) => entry.guildId === guildId);
    return guildAllowed.length === 1
      ? expectDefined(guildAllowed.at(0), "single allowed guild voice channel")
      : null;
  }

  private readReconcileVoiceState(guildId: string, userId: string, reason: string, isBot = false) {
    return getGuildVoiceState(this.params.client.rest, guildId, userId).catch((err: unknown) => {
      if (!isUnknownDiscordVoiceStateError(err)) {
        logger.warn(
          isBot
            ? `discord voice: follow reconcile skipped transient bot voice state error guild=${guildId} reason=${reason}: ${formatErrorMessage(err)}`
            : `follow-user reconcile skipped (transient voice-state error) guild=${guildId} user=${userId} trigger=${reason}: ${formatErrorMessage(err)}`,
        );
        return "transient-error" as const;
      }
      logFollowUserReconcileVerbose(
        reason,
        isBot
          ? `follow user reconcile reason=${reason}: no bot voice state guild ${guildId}: ${formatErrorMessage(err)}`
          : `follow user reconcile reason=${reason}: no voice state guild ${guildId} user ${userId}: ${formatErrorMessage(err)}`,
      );
      return undefined;
    });
  }
}
