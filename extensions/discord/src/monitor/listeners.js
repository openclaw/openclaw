import {
  ChannelType,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
  ThreadUpdateListener
} from "@buape/carbon";
import { danger, logVerbose } from "../../../../src/globals.js";
import { formatDurationSeconds } from "../../../../src/infra/format-time/format-duration.ts";
import { enqueueSystemEvent } from "../../../../src/infra/system-events.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { resolveAgentRoute } from "../../../../src/routing/resolve-route.js";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists
} from "../../../../src/security/dm-policy-shared.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordMemberAccessState,
  resolveGroupDmAllow,
  resolveDiscordGuildEntry,
  shouldEmitDiscordReactionNotification
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { setPresence } from "./presence-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";
import { normalizeDiscordListenerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";
const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 3e4;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");
function formatListenerContextValue(value) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}
function formatListenerContextSuffix(context) {
  if (!context) {
    return "";
  }
  const entries = Object.entries(context).flatMap(([key, value]) => {
    const formatted = formatListenerContextValue(value);
    return formatted ? [`${key}=${formatted}`] : [];
  });
  if (entries.length === 0) {
    return "";
  }
  return ` (${entries.join(" ")})`;
}
function logSlowDiscordListener(params) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) {
    return;
  }
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds"
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    ...params.context,
    consoleMessage: `${message}${formatListenerContextSuffix(params.context)}`
  });
}
async function runDiscordListenerWithSlowLog(params) {
  const startedAt = Date.now();
  const timeoutMs = normalizeDiscordListenerTimeoutMs(params.timeoutMs);
  const logger = params.logger ?? discordEventQueueLog;
  let timedOut = false;
  try {
    timedOut = await runDiscordTaskWithTimeout({
      run: params.run,
      timeoutMs,
      onTimeout: (resolvedTimeoutMs) => {
        logger.error(
          danger(
            `discord handler timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
              decimals: 1,
              unit: "seconds"
            })}${formatListenerContextSuffix(params.context)}`
          )
        );
      },
      onAbortAfterTimeout: () => {
        logger.warn(
          `discord handler canceled after timeout${formatListenerContextSuffix(params.context)}`
        );
      },
      onErrorAfterTimeout: (err) => {
        logger.error(
          danger(
            `discord handler failed after timeout: ${String(err)}${formatListenerContextSuffix(params.context)}`
          )
        );
      }
    });
    if (timedOut) {
      return;
    }
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    throw err;
  } finally {
    if (!timedOut) {
      logSlowDiscordListener({
        logger: params.logger,
        listener: params.listener,
        event: params.event,
        durationMs: Date.now() - startedAt,
        context: params.context
      });
    }
  }
}
function registerDiscordListener(listeners, listener) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}
class DiscordMessageListener extends MessageCreateListener {
  constructor(handler, logger, onEvent, _options) {
    super();
    this.handler = handler;
    this.logger = logger;
    this.onEvent = onEvent;
  }
  async handle(data, client) {
    this.onEvent?.();
    void Promise.resolve().then(() => this.handler(data, client)).catch((err) => {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord handler failed: ${String(err)}`));
    });
  }
}
class DiscordReactionListener extends MessageReactionAddListener {
  constructor(params) {
    super();
    this.params = params;
  }
  async handle(data, client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      data,
      client,
      action: "added",
      handlerParams: this.params,
      listener: this.constructor.name,
      event: this.type
    });
  }
}
class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(params) {
    super();
    this.params = params;
  }
  async handle(data, client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      data,
      client,
      action: "removed",
      handlerParams: this.params,
      listener: this.constructor.name,
      event: this.type
    });
  }
}
async function runDiscordReactionHandler(params) {
  await runDiscordListenerWithSlowLog({
    logger: params.handlerParams.logger,
    listener: params.listener,
    event: params.event,
    run: async () => handleDiscordReactionEvent({
      data: params.data,
      client: params.client,
      action: params.action,
      cfg: params.handlerParams.cfg,
      accountId: params.handlerParams.accountId,
      botUserId: params.handlerParams.botUserId,
      dmEnabled: params.handlerParams.dmEnabled,
      groupDmEnabled: params.handlerParams.groupDmEnabled,
      groupDmChannels: params.handlerParams.groupDmChannels,
      dmPolicy: params.handlerParams.dmPolicy,
      allowFrom: params.handlerParams.allowFrom,
      groupPolicy: params.handlerParams.groupPolicy,
      allowNameMatching: params.handlerParams.allowNameMatching,
      guildEntries: params.handlerParams.guildEntries,
      logger: params.handlerParams.logger
    })
  });
}
async function authorizeDiscordReactionIngress(params) {
  if (params.isDirectMessage && !params.dmEnabled) {
    return { allowed: false, reason: "dm-disabled" };
  }
  if (params.isGroupDm && !params.groupDmEnabled) {
    return { allowed: false, reason: "group-dm-disabled" };
  }
  if (params.isDirectMessage) {
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: "discord",
      accountId: params.accountId,
      dmPolicy: params.dmPolicy
    });
    const access = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: params.dmPolicy,
      groupPolicy: params.groupPolicy,
      allowFrom: params.allowFrom,
      groupAllowFrom: [],
      storeAllowFrom,
      isSenderAllowed: (allowEntries) => {
        const allowList = normalizeDiscordAllowList(allowEntries, ["discord:", "user:", "pk:"]);
        const allowMatch = allowList ? resolveDiscordAllowListMatch({
          allowList,
          candidate: {
            id: params.user.id,
            name: params.user.username,
            tag: formatDiscordUserTag(params.user)
          },
          allowNameMatching: params.allowNameMatching
        }) : { allowed: false };
        return allowMatch.allowed;
      }
    });
    if (access.decision !== "allow") {
      return { allowed: false, reason: access.reason };
    }
  }
  if (params.isGroupDm && !resolveGroupDmAllow({
    channels: params.groupDmChannels,
    channelId: params.channelId,
    channelName: params.channelName,
    channelSlug: params.channelSlug
  })) {
    return { allowed: false, reason: "group-dm-not-allowlisted" };
  }
  if (!params.isGuildMessage) {
    return { allowed: true };
  }
  const channelAllowlistConfigured = Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = params.channelConfig?.allowed !== false;
  if (!isDiscordGroupAllowedByPolicy({
    groupPolicy: params.groupPolicy,
    guildAllowlisted: Boolean(params.guildInfo),
    channelAllowlistConfigured,
    channelAllowed
  })) {
    return { allowed: false, reason: "guild-policy" };
  }
  if (params.channelConfig?.allowed === false) {
    return { allowed: false, reason: "guild-channel-denied" };
  }
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: {
      id: params.user.id,
      name: params.user.username,
      tag: formatDiscordUserTag(params.user)
    },
    allowNameMatching: params.allowNameMatching
  });
  if (hasAccessRestrictions && !memberAllowed) {
    return { allowed: false, reason: "guild-member-denied" };
  }
  return { allowed: true };
}
async function handleDiscordReactionEvent(params) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
    if (!("user" in data)) {
      return;
    }
    const user = data.user;
    if (!user || user.bot) {
      return;
    }
    if (botUserId && user.id === botUserId) {
      return;
    }
    const isGuildMessage = Boolean(data.guild_id);
    const guildInfo = isGuildMessage ? resolveDiscordGuildEntry({
      guild: data.guild ?? void 0,
      guildId: data.guild_id ?? void 0,
      guildEntries
    }) : null;
    if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }
    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) {
      return;
    }
    const channelName = "name" in channel ? channel.name ?? void 0 : void 0;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelType = "type" in channel ? channel.type : void 0;
    const isDirectMessage = channelType === ChannelType.DM;
    const isGroupDm = channelType === ChannelType.GroupDM;
    const isThreadChannel = channelType === ChannelType.PublicThread || channelType === ChannelType.PrivateThread || channelType === ChannelType.AnnouncementThread;
    const memberRoleIds = Array.isArray(data.rawMember?.roles) ? data.rawMember.roles.map((roleId) => String(roleId)) : [];
    const reactionIngressBase = {
      accountId: params.accountId,
      user,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      isGuildMessage,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      dmEnabled: params.dmEnabled,
      groupDmEnabled: params.groupDmEnabled,
      groupDmChannels: params.groupDmChannels,
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom,
      groupPolicy: params.groupPolicy,
      allowNameMatching: params.allowNameMatching,
      guildInfo
    };
    if (!isGuildMessage) {
      const ingressAccess = await authorizeDiscordReactionIngress(reactionIngressBase);
      if (!ingressAccess.allowed) {
        logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
        return;
      }
    }
    let parentId = "parentId" in channel ? channel.parentId ?? void 0 : void 0;
    let parentName;
    let parentSlug = "";
    let reactionBase = null;
    const resolveReactionBase = () => {
      if (reactionBase) {
        return reactionBase;
      }
      const emojiLabel = formatDiscordReactionEmoji(data.emoji);
      const actorLabel = formatDiscordUserTag(user);
      const guildSlug = guildInfo?.slug || (data.guild?.name ? normalizeDiscordSlug(data.guild.name) : data.guild_id ?? (isGroupDm ? "group-dm" : "dm"));
      const channelLabel = channelSlug ? `#${channelSlug}` : channelName ? `#${normalizeDiscordSlug(channelName)}` : `#${data.channel_id}`;
      const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
      const contextKey = `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`;
      reactionBase = { baseText, contextKey };
      return reactionBase;
    };
    const emitReaction = (text, parentPeerId) => {
      const { contextKey } = resolveReactionBase();
      const route = resolveAgentRoute({
        cfg: params.cfg,
        channel: "discord",
        accountId: params.accountId,
        guildId: data.guild_id ?? void 0,
        memberRoleIds,
        peer: {
          kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : data.channel_id
        },
        parentPeer: parentPeerId ? { kind: "channel", id: parentPeerId } : void 0
      });
      enqueueSystemEvent(text, {
        sessionKey: route.sessionKey,
        contextKey
      });
    };
    const shouldNotifyReaction = (options) => shouldEmitDiscordReactionNotification({
      mode: options.mode,
      botId: botUserId,
      messageAuthorId: options.messageAuthorId,
      userId: user.id,
      userName: user.username,
      userTag: formatDiscordUserTag(user),
      channelConfig: options.channelConfig,
      guildInfo,
      memberRoleIds,
      allowNameMatching: params.allowNameMatching
    });
    const emitReactionWithAuthor = (message2) => {
      const { baseText } = resolveReactionBase();
      const authorLabel = message2?.author ? formatDiscordUserTag(message2.author) : void 0;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      emitReaction(text, parentId);
    };
    const loadThreadParentInfo = async () => {
      if (!parentId) {
        return;
      }
      const parentInfo = await resolveDiscordChannelInfo(client, parentId);
      parentName = parentInfo?.name;
      parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
    };
    const resolveThreadChannelConfig = () => resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: "thread"
    });
    const authorizeReactionIngressForChannel = async (channelConfig2) => await authorizeDiscordReactionIngress({
      ...reactionIngressBase,
      channelConfig: channelConfig2
    });
    const resolveThreadChannelAccess = async (channelInfo) => {
      parentId = channelInfo?.parentId;
      await loadThreadParentInfo();
      const channelConfig2 = resolveThreadChannelConfig();
      const access = await authorizeReactionIngressForChannel(channelConfig2);
      return { access, channelConfig: channelConfig2 };
    };
    if (isThreadChannel) {
      const reactionMode2 = guildInfo?.reactionNotifications ?? "own";
      if (reactionMode2 === "off") {
        return;
      }
      const channelInfoPromise = parentId ? Promise.resolve({ parentId }) : resolveDiscordChannelInfo(client, data.channel_id);
      if (reactionMode2 === "all" || reactionMode2 === "allowlist") {
        const channelInfo2 = await channelInfoPromise;
        const { access: threadAccess2, channelConfig: threadChannelConfig2 } = await resolveThreadChannelAccess(channelInfo2);
        if (!threadAccess2.allowed) {
          return;
        }
        if (!shouldNotifyReaction({
          mode: reactionMode2,
          channelConfig: threadChannelConfig2
        })) {
          return;
        }
        const { baseText } = resolveReactionBase();
        emitReaction(baseText, parentId);
        return;
      }
      const messagePromise = data.message.fetch().catch(() => null);
      const [channelInfo, message2] = await Promise.all([channelInfoPromise, messagePromise]);
      const { access: threadAccess, channelConfig: threadChannelConfig } = await resolveThreadChannelAccess(channelInfo);
      if (!threadAccess.allowed) {
        return;
      }
      const messageAuthorId2 = message2?.author?.id ?? void 0;
      if (!shouldNotifyReaction({
        mode: reactionMode2,
        messageAuthorId: messageAuthorId2,
        channelConfig: threadChannelConfig
      })) {
        return;
      }
      emitReactionWithAuthor(message2);
      return;
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: "channel"
    });
    if (isGuildMessage) {
      const channelAccess = await authorizeReactionIngressForChannel(channelConfig);
      if (!channelAccess.allowed) {
        return;
      }
    }
    const reactionMode = guildInfo?.reactionNotifications ?? "own";
    if (reactionMode === "off") {
      return;
    }
    if (reactionMode === "all" || reactionMode === "allowlist") {
      if (!shouldNotifyReaction({ mode: reactionMode, channelConfig })) {
        return;
      }
      const { baseText } = resolveReactionBase();
      emitReaction(baseText, parentId);
      return;
    }
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? void 0;
    if (!shouldNotifyReaction({ mode: reactionMode, messageAuthorId, channelConfig })) {
      return;
    }
    emitReactionWithAuthor(message);
  } catch (err) {
    params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
  }
}
class DiscordPresenceListener extends PresenceUpdateListener {
  constructor(params) {
    super();
    this.logger = params.logger;
    this.accountId = params.accountId;
  }
  async handle(data) {
    try {
      const userId = "user" in data && data.user && typeof data.user === "object" && "id" in data.user ? String(data.user.id) : void 0;
      if (!userId) {
        return;
      }
      setPresence(
        this.accountId,
        userId,
        data
      );
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    }
  }
}
class DiscordThreadUpdateListener extends ThreadUpdateListener {
  constructor(cfg, accountId, logger) {
    super();
    this.cfg = cfg;
    this.accountId = accountId;
    this.logger = logger;
  }
  async handle(data) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: async () => {
        if (!isThreadArchived(data)) {
          return;
        }
        const threadId = "id" in data && typeof data.id === "string" ? data.id : void 0;
        if (!threadId) {
          return;
        }
        const logger = this.logger ?? discordEventQueueLog;
        logger.info("Discord thread archived \u2014 resetting session", { threadId });
        const count = await closeDiscordThreadSessions({
          cfg: this.cfg,
          accountId: this.accountId,
          threadId
        });
        if (count > 0) {
          logger.info("Discord thread sessions reset after archival", { threadId, count });
        }
      },
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-update handler failed: ${String(err)}`));
      }
    });
  }
}
export {
  DiscordMessageListener,
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  DiscordThreadUpdateListener,
  registerDiscordListener
};
