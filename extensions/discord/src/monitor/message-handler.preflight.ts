import { ChannelType, MessageType, type User } from "@buape/carbon";
import {
  ensureConfiguredAcpRouteReady,
  resolveConfiguredAcpRoute,
} from "../../../../src/acp/persistent-bindings.route.js";
import { hasControlCommand } from "../../../../src/auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../../../src/auto-reply/commands-registry.js";
import {
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../../../../src/auto-reply/reply/history.js";
import {
  buildMentionRegexes,
  matchesMentionWithExplicit,
} from "../../../../src/auto-reply/reply/mentions.js";
import { formatAllowlistMatchMeta } from "../../../../src/channels/allowlist-match.js";
import { resolveControlCommandGate } from "../../../../src/channels/command-gating.js";
import { logInboundDrop } from "../../../../src/channels/logging.js";
import { resolveMentionGatingWithBypass } from "../../../../src/channels/mention-gating.js";
import { loadConfig } from "../../../../src/config/config.js";
import { isDangerousNameMatchingEnabled } from "../../../../src/config/dangerous-name-matching.js";
import { logVerbose, shouldLogVerbose } from "../../../../src/globals.js";
import { recordChannelActivity } from "../../../../src/infra/channel-activity.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../../src/infra/outbound/session-binding-service.js";
import { enqueueSystemEvent } from "../../../../src/infra/system-events.js";
import { logDebug } from "../../../../src/logger.js";
import { getChildLogger } from "../../../../src/logging.js";
import { buildPairingReply } from "../../../../src/pairing/pairing-messages.js";
import { isPluginOwnedSessionBindingRecord } from "../../../../src/plugins/conversation-binding.js";
import { DEFAULT_ACCOUNT_ID } from "../../../../src/routing/session-key.js";
import { fetchPluralKitMessageInfo } from "../pluralkit.js";
import { sendMessageDiscord } from "../send.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import {
  formatDiscordUserTag,
  resolveDiscordSystemLocation,
  resolveTimestampMs,
} from "./format.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import { resolveDiscordPreflightAudioMentionContext } from "./preflight-audio.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import { resolveDiscordSenderIdentity, resolveDiscordWebhookId } from "./sender-identity.js";
import { resolveDiscordSystemEvent } from "./system-events.js";
import { isRecentlyUnboundThreadWebhookMessage } from "./thread-bindings.js";
import { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } from "./threading.js";

export type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = ["⚙️", "🤖", "🧰"];

// Cache for bot mention regexes to avoid recompilation on every message
// Key: botId, Value: compiled regex for <@botId> or <@!botId>
const botMentionRegexCache = new Map<string, RegExp>();

/**
 * Get or create a cached regex for detecting bot mentions in message text.
 * Matches both standard (<@id>) and nickname (<@!id>) mention formats.
 */
function getBotMentionRegex(botId: string): RegExp {
  let regex = botMentionRegexCache.get(botId);
  if (!regex) {
    regex = new RegExp(`<@!?${botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`);
    botMentionRegexCache.set(botId, regex);
  }
  return regex;
}

function isPreflightAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function isBoundThreadBotSystemMessage(params: {
  isBoundThreadSession: boolean;
  isBotAuthor: boolean;
  text?: string;
}): boolean {
  if (!params.isBoundThreadSession || !params.isBotAuthor) {
    return false;
  }
  const text = params.text?.trim();
  if (!text) {
    return false;
  }
  return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function resolvePreflightMentionRequirement(params: {
  shouldRequireMention: boolean;
  isBoundThreadSession: boolean;
}): boolean {
  if (!params.shouldRequireMention) {
    return false;
  }
  return !params.isBoundThreadSession;
}

export function shouldIgnoreBoundThreadWebhookMessage(params: {
  accountId?: string;
  threadId?: string;
  webhookId?: string | null;
  threadBinding?: SessionBindingRecord;
}): boolean {
  const webhookId = params.webhookId?.trim() || "";
  if (!webhookId) {
    return false;
  }
  const boundWebhookId =
    typeof params.threadBinding?.metadata?.webhookId === "string"
      ? params.threadBinding.metadata.webhookId.trim()
      : "";
  if (!boundWebhookId) {
    const threadId = params.threadId?.trim() || "";
    if (!threadId) {
      return false;
    }
    return isRecentlyUnboundThreadWebhookMessage({
      accountId: params.accountId,
      threadId,
      webhookId,
    });
  }
  return webhookId === boundWebhookId;
}

export async function preflightDiscordMessage(
  params: DiscordMessagePreflightParams,
): Promise<DiscordMessagePreflightContext | null> {
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const logger = getChildLogger({ module: "discord-auto-reply" });
  const message = params.data.message;
  const author = params.data.author;
  if (!author) {
    return null;
  }
  const messageChannelId = resolveDiscordMessageChannelId({
    message,
    eventChannelId: params.data.channel_id,
  });
  if (!messageChannelId) {
    logVerbose(`discord: drop message ${message.id} (missing channel id)`);
    return null;
  }

  const allowBotsSetting = params.discordConfig?.allowBots;
  const allowBotsMode =
    allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting === true ? "all" : "off";
  if (params.botUserId && author.id === params.botUserId) {
    // Always ignore own messages to prevent self-reply loops
    return null;
  }

  const pluralkitConfig = params.discordConfig?.pluralkit;
  const webhookId = resolveDiscordWebhookId(message);
  const shouldCheckPluralKit = Boolean(pluralkitConfig?.enabled) && !webhookId;
  let pluralkitInfo: Awaited<ReturnType<typeof fetchPluralKitMessageInfo>> = null;
  if (shouldCheckPluralKit) {
    try {
      pluralkitInfo = await fetchPluralKitMessageInfo({
        messageId: message.id,
        config: pluralkitConfig,
      });
      if (isPreflightAborted(params.abortSignal)) {
        return null;
      }
    } catch (err) {
      logVerbose(`discord: pluralkit lookup failed for ${message.id}: ${String(err)}`);
    }
  }
  const sender = resolveDiscordSenderIdentity({
    author,
    member: params.data.member,
    pluralkitInfo,
  });

  if (author.bot) {
    if (allowBotsMode === "off" && !sender.isPluralKit) {
      logVerbose("discord: drop bot message (allowBots=false)");
      return null;
    }
  }

  const isGuildMessage = Boolean(params.data.guild_id);
  const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const isDirectMessage = channelInfo?.type === ChannelType.DM;
  const isGroupDm = channelInfo?.type === ChannelType.GroupDM;
  logDebug(
    `[discord-preflight] channelId=${messageChannelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`,
  );

  if (isGroupDm && !params.groupDmEnabled) {
    logVerbose("discord: drop group dm (group dms disabled)");
    return null;
  }
  if (isDirectMessage && !params.dmEnabled) {
    logVerbose("discord: drop dm (dms disabled)");
    return null;
  }

  const dmPolicy = params.discordConfig?.dmPolicy ?? params.discordConfig?.dm?.policy ?? "pairing";
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const resolvedAccountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (dmPolicy === "disabled") {
      logVerbose("discord: drop dm (dmPolicy: disabled)");
      return null;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId: resolvedAccountId,
      dmPolicy,
      configuredAllowFrom: params.allowFrom ?? [],
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
      useAccessGroups,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    commandAuthorized = dmAccess.commandAuthorized;
    if (dmAccess.decision !== "allow") {
      const allowMatchMeta = formatAllowlistMatchMeta(
        dmAccess.allowMatch.allowed ? dmAccess.allowMatch : undefined,
      );
      await handleDiscordDmCommandDecision({
        dmAccess,
        accountId: resolvedAccountId,
        sender: {
          id: author.id,
          tag: formatDiscordUserTag(author),
          name: author.username ?? undefined,
        },
        onPairingCreated: async (code) => {
          logVerbose(
            `discord pairing request sender=${author.id} tag=${formatDiscordUserTag(author)} (${allowMatchMeta})`,
          );
          try {
            await sendMessageDiscord(
              `user:${author.id}`,
              buildPairingReply({
                channel: "discord",
                idLine: `Your Discord user id: ${author.id}`,
                code,
              }),
              {
                token: params.token,
                rest: params.client.rest,
                accountId: params.accountId,
              },
            );
          } catch (err) {
            logVerbose(`discord pairing reply failed for ${author.id}: ${String(err)}`);
          }
        },
        onUnauthorized: async () => {
          logVerbose(
            `Blocked unauthorized discord sender ${sender.id} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
          );
        },
      });
      return null;
    }
  }

  const botId = params.botUserId;
  const baseText = resolveDiscordMessageText(message, {
    includeForwarded: false,
  });
  const messageText = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });

  // Intercept text-only slash commands (e.g. user typing "/reset" instead of using Discord's slash command picker)
  // These should not be forwarded to the agent; proper slash command interactions are handled elsewhere
  if (!isDirectMessage && baseText && hasControlCommand(baseText, params.cfg)) {
    logVerbose(`discord: drop text-based slash command ${message.id} (intercepted at gateway)`);
    return null;
  }

  recordChannelActivity({
    channel: "discord",
    accountId: params.accountId,
    direction: "inbound",
  });

  // Resolve thread parent early for binding inheritance
  const channelName =
    channelInfo?.name ??
    ((isGuildMessage || isGroupDm) && message.channel && "name" in message.channel
      ? message.channel.name
      : undefined);
  const earlyThreadChannel = resolveDiscordThreadChannel({
    isGuildMessage,
    message,
    channelInfo,
    messageChannelId,
  });
  let earlyThreadParentId: string | undefined;
  let earlyThreadParentName: string | undefined;
  let earlyThreadParentType: ChannelType | undefined;
  if (earlyThreadChannel) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: params.client,
      threadChannel: earlyThreadChannel,
      channelInfo,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    earlyThreadParentId = parentInfo.id;
    earlyThreadParentName = parentInfo.name;
    earlyThreadParentType = parentInfo.type;
  }

  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const memberRoleIds = Array.isArray(params.data.rawMember?.roles)
    ? params.data.rawMember.roles.map((roleId: string) => String(roleId))
    : [];
  const freshCfg = loadConfig();
  const route = resolveDiscordConversationRoute({
    cfg: freshCfg,
    accountId: params.accountId,
    guildId: params.data.guild_id ?? undefined,
    memberRoleIds,
    peer: buildDiscordRoutePeer({
      isDirectMessage,
      isGroupDm,
      directUserId: author.id,
      conversationId: messageChannelId,
    }),
    parentConversationId: earlyThreadParentId,
  });
  const bindingConversationId = isDirectMessage ? `user:${author.id}` : messageChannelId;
  let threadBinding: SessionBindingRecord | undefined;
  threadBinding =
    getSessionBindingService().resolveByConversation({
      channel: "discord",
      accountId: params.accountId,
      conversationId: bindingConversationId,
      parentConversationId: earlyThreadParentId,
    }) ?? undefined;
  const configuredRoute =
    threadBinding == null
      ? resolveConfiguredAcpRoute({
          cfg: freshCfg,
          route,
          channel: "discord",
          accountId: params.accountId,
          conversationId: messageChannelId,
          parentConversationId: earlyThreadParentId,
        })
      : null;
  const configuredBinding = configuredRoute?.configuredBinding ?? null;
  if (!threadBinding && configuredBinding) {
    threadBinding = configuredBinding.record;
  }
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      accountId: params.accountId,
      threadId: messageChannelId,
      webhookId,
      threadBinding,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  const boundSessionKey = isPluginOwnedSessionBindingRecord(threadBinding)
    ? ""
    : threadBinding?.targetSessionKey?.trim();
  const effectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: "binding.channel",
  });
  const boundAgentId = boundSessionKey ? effectiveRoute.agentId : undefined;
  const isBoundThreadSession = Boolean(threadBinding && earlyThreadChannel);
  if (
    isBoundThreadBotSystemMessage({
      isBoundThreadSession,
      isBotAuthor: Boolean(author.bot),
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const mentionRegexes = buildMentionRegexes(params.cfg, effectiveRoute.agentId);
  // Check explicit mention via Discord's mentionedUsers array, with fallback
  // to text-based detection for threads where mentionedUsers may be unpopulated.
  // Fixes #44183: Discord thread mentions not working
  const explicitlyMentionedViaArray = Boolean(
    botId && message.mentionedUsers?.some((user: User) => user.id === botId),
  );
  const explicitlyMentionedViaText = Boolean(
    botId && baseText && getBotMentionRegex(botId).test(baseText),
  );
  const explicitlyMentioned = explicitlyMentionedViaArray || explicitlyMentionedViaText;

  // Log when fallback detection is used (helps diagnose Discord API issues)
  if (explicitlyMentionedViaText && !explicitlyMentionedViaArray) {
    logVerbose(
      `discord: mention detected via text fallback (thread workaround) ` +
      `channel=${messageChannelId} botId=${botId}`,
    );
  }
  const hasAnyMention = Boolean(
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 ||
      (message.mentionedRoles?.length ?? 0) > 0 ||
      (message.mentionedEveryone && (!author.bot || sender.isPluralKit))),
  );
  const hasUserOrRoleMention = Boolean(
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0),
  );

  if (
    isGuildMessage &&
    (message.type === MessageType.ChatInputCommand ||
      message.type === MessageType.ContextMenuCommand)
  ) {
    logVerbose("discord: drop channel command message");
    return null;
  }

  const guildInfo = isGuildMessage
    ? resolveDiscordGuildEntry({
        guild: params.data.guild ?? undefined,
        guildId: params.data.guild_id ?? undefined,
        guildEntries: params.guildEntries,
      })
    : null;
  logDebug(
    `[discord-preflight] guild_id=${params.data.guild_id} guild_obj=${!!params.data.guild} guild_obj_id=${params.data.guild?.id} guildInfo=${!!guildInfo} guildEntries=${params.guildEntries ? Object.keys(params.guildEntries).join(",") : "none"}`,
  );
  if (
    isGuildMessage &&
    params.guildEntries &&
    Object.keys(params.guildEntries).length > 0 &&
    !guildInfo
  ) {
    logDebug(
      `[discord-preflight] guild blocked: guild_id=${params.data.guild_id} guildEntries keys=${Object.keys(params.guildEntries).join(",")}`,
    );
    logVerbose(
      `Blocked discord guild ${params.data.guild_id ?? "unknown"} (not in discord.guilds)`,
    );
    return null;
  }

  // Reuse early thread resolution from above (for binding inheritance)
  const threadChannel = earlyThreadChannel;
  const threadParentId = earlyThreadParentId;
  const threadParentName = earlyThreadParentName;
  const threadParentType = earlyThreadParentType;
  const threadName = threadChannel?.name;
  const configChannelName = threadParentName ?? channelName;
  const configChannelSlug = configChannelName ? normalizeDiscordSlug(configChannelName) : "";
  const displayChannelName = threadName ?? channelName;
  const displayChannelSlug = displayChannelName ? normalizeDiscordSlug(displayChannelName) : "";
  const guildSlug =
    guildInfo?.slug ||
    (params.data.guild?.name ? normalizeDiscordSlug(params.data.guild.name) : "");

  const threadChannelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";

  const baseSessionKey = effectiveRoute.sessionKey;
  const channelConfig = isGuildMessage
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: messageChannelId,
        channelName,
        channelSlug: threadChannelSlug,
        parentId: threadParentId ?? undefined,
        parentName: threadParentName ?? undefined,
        parentSlug: threadParentSlug,
        scope: threadChannel ? "thread" : "channel",
      })
    : null;
  const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
  if (shouldLogVerbose()) {
    const channelConfigSummary = channelConfig
      ? `allowed=${channelConfig.allowed} enabled=${channelConfig.enabled ?? "unset"} requireMention=${channelConfig.requireMention ?? "unset"} ignoreOtherMentions=${channelConfig.ignoreOtherMentions ?? "unset"} matchKey=${channelConfig.matchKey ?? "none"} matchSource=${channelConfig.matchSource ?? "none"} users=${channelConfig.users?.length ?? 0} roles=${channelConfig.roles?.length ?? 0} skills=${channelConfig.skills?.length ?? 0}`
      : "none";
    logDebug(
      `[discord-preflight] channelConfig=${channelConfigSummary} channelMatchMeta=${channelMatchMeta} channelId=${messageChannelId}`,
    );
  }
  if (isGuildMessage && channelConfig?.enabled === false) {
    logDebug(`[discord-preflight] drop: channel disabled`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} (channel disabled, ${channelMatchMeta})`,
    );
    return null;
  }

  const groupDmAllowed =
    isGroupDm &&
    resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: messageChannelId,
      channelName: displayChannelName,
      channelSlug: displayChannelSlug,
    });
  if (isGroupDm && !groupDmAllowed) {
    return null;
  }

  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    isGuildMessage &&
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    if (params.groupPolicy === "disabled") {
      logDebug(`[discord-preflight] drop: groupPolicy disabled`);
      logVerbose(`discord: drop guild message (groupPolicy: disabled, ${channelMatchMeta})`);
    } else if (!channelAllowlistConfigured) {
      logDebug(`[discord-preflight] drop: groupPolicy allowlist, no channel allowlist configured`);
      logVerbose(
        `discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${channelMatchMeta})`,
      );
    } else {
      logDebug(
        `[discord] Ignored message from channel ${messageChannelId} (not in guild allowlist). Add to guilds.<guildId>.channels to enable.`,
      );
      logVerbose(
        `Blocked discord channel ${messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${channelMatchMeta})`,
      );
    }
    return null;
  }

  if (isGuildMessage && channelConfig?.allowed === false) {
    logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} not in guild channel allowlist (${channelMatchMeta})`,
    );
    return null;
  }
  if (isGuildMessage) {
    logDebug(`[discord-preflight] pass: channel allowed`);
    logVerbose(`discord: allow channel ${messageChannelId} (${channelMatchMeta})`);
  }

  const textForHistory = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
  const historyEntry =
    isGuildMessage && params.historyLimit > 0 && textForHistory
      ? ({
          sender: sender.label,
          body: textForHistory,
          timestamp: resolveTimestampMs(message.timestamp),
          messageId: message.id,
        } satisfies HistoryEntry)
      : undefined;

  const threadOwnerId = threadChannel ? (threadChannel.ownerId ?? channelInfo?.ownerId) : undefined;
  const shouldRequireMentionByConfig = resolveDiscordShouldRequireMention({
    isGuildMessage,
    isThread: Boolean(threadChannel),
    botId,
    threadOwnerId,
    channelConfig,
    guildInfo,
  });
  const shouldRequireMention = resolvePreflightMentionRequirement({
    shouldRequireMention: shouldRequireMentionByConfig,
    isBoundThreadSession,
  });

  // Preflight audio transcription for mention detection in guilds.
  // This allows voice notes to be checked for mentions before being dropped.
  const { hasTypedText, transcript: preflightTranscript } =
    await resolveDiscordPreflightAudioMentionContext({
      message,
      isDirectMessage,
      shouldRequireMention,
      mentionRegexes,
      cfg: params.cfg,
      abortSignal: params.abortSignal,
    });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }

  const mentionText = hasTypedText ? baseText : "";
  const wasMentioned =
    !isDirectMessage &&
    matchesMentionWithExplicit({
      text: mentionText,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(botId),
      },
      transcript: preflightTranscript,
    });
  const implicitMention = Boolean(
    !isDirectMessage &&
    botId &&
    message.referencedMessage?.author?.id &&
    message.referencedMessage.author.id === botId,
  );
  if (shouldLogVerbose()) {
    logVerbose(
      `discord: inbound id=${message.id} guild=${params.data.guild_id ?? "dm"} channel=${messageChannelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${messageText ? "yes" : "no"}`,
    );
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: "discord",
  });
  const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender,
    allowNameMatching,
  });

  if (!isDirectMessage) {
    const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
      allowFrom: params.allowFrom,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: ownerAllowList != null, allowed: ownerOk },
        { configured: hasAccessRestrictions, allowed: memberAllowed },
      ],
      modeWhenAccessGroupsOff: "configured",
      allowTextCommands,
      hasControlCommand: hasControlCommandInMessage,
    });
    commandAuthorized = commandGate.commandAuthorized;

    if (commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "discord",
        reason: "control command (unauthorized)",
        target: sender.id,
      });
      return null;
    }
  }

  const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup: isGuildMessage,
    requireMention: Boolean(shouldRequireMention),
    canDetectMention,
    wasMentioned,
    implicitMention,
    hasAnyMention,
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized,
  });
  const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  logDebug(
    `[discord-preflight] shouldRequireMention=${shouldRequireMention} baseRequireMention=${shouldRequireMentionByConfig} boundThreadSession=${isBoundThreadSession} mentionGate.shouldSkip=${mentionGate.shouldSkip} wasMentioned=${wasMentioned}`,
  );
  if (isGuildMessage && shouldRequireMention) {
    if (botId && mentionGate.shouldSkip) {
      logDebug(`[discord-preflight] drop: no-mention`);
      logVerbose(`discord: drop guild message (mention required, botId=${botId})`);
      logger.info(
        {
          channelId: messageChannelId,
          reason: "no-mention",
        },
        "discord: skipping guild message",
      );
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.guildHistories,
        historyKey: messageChannelId,
        limit: params.historyLimit,
        entry: historyEntry ?? null,
      });
      return null;
    }
  }

  if (author.bot && !sender.isPluralKit && allowBotsMode === "mentions") {
    const botMentioned = isDirectMessage || wasMentioned || implicitMention;
    if (!botMentioned) {
      logDebug(`[discord-preflight] drop: bot message missing mention (allowBots=mentions)`);
      logVerbose("discord: drop bot message (allowBots=mentions, missing mention)");
      return null;
    }
  }

  const ignoreOtherMentions =
    channelConfig?.ignoreOtherMentions ?? guildInfo?.ignoreOtherMentions ?? false;
  if (
    isGuildMessage &&
    ignoreOtherMentions &&
    hasUserOrRoleMention &&
    !wasMentioned &&
    !implicitMention
  ) {
    logDebug(`[discord-preflight] drop: other-mention`);
    logVerbose(
      `discord: drop guild message (another user/role mentioned, ignoreOtherMentions=true, botId=${botId})`,
    );
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.guildHistories,
      historyKey: messageChannelId,
      limit: params.historyLimit,
      entry: historyEntry ?? null,
    });
    return null;
  }

  if (isGuildMessage && hasAccessRestrictions && !memberAllowed) {
    logDebug(`[discord-preflight] drop: member not allowed`);
    logVerbose(`Blocked discord guild sender ${sender.id} (not in users/roles allowlist)`);
    return null;
  }

  const systemLocation = resolveDiscordSystemLocation({
    isDirectMessage,
    isGroupDm,
    guild: params.data.guild ?? undefined,
    channelName: channelName ?? messageChannelId,
  });
  const systemText = resolveDiscordSystemEvent(message, systemLocation);
  if (systemText) {
    logDebug(`[discord-preflight] drop: system event`);
    enqueueSystemEvent(systemText, {
      sessionKey: effectiveRoute.sessionKey,
      contextKey: `discord:system:${messageChannelId}:${message.id}`,
    });
    return null;
  }

  if (!messageText) {
    logDebug(`[discord-preflight] drop: empty content`);
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return null;
  }
  if (configuredBinding) {
    const ensured = await ensureConfiguredAcpRouteReady({
      cfg: freshCfg,
      configuredBinding,
    });
    if (!ensured.ok) {
      logVerbose(
        `discord: configured ACP binding unavailable for channel ${configuredBinding.spec.conversationId}: ${ensured.error}`,
      );
      return null;
    }
  }

  logDebug(
    `[discord-preflight] success: route=${effectiveRoute.agentId} sessionKey=${effectiveRoute.sessionKey}`,
  );
  return {
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: params.accountId,
    token: params.token,
    runtime: params.runtime,
    botUserId: params.botUserId,
    abortSignal: params.abortSignal,
    guildHistories: params.guildHistories,
    historyLimit: params.historyLimit,
    mediaMaxBytes: params.mediaMaxBytes,
    textLimit: params.textLimit,
    replyToMode: params.replyToMode,
    ackReactionScope: params.ackReactionScope,
    groupPolicy: params.groupPolicy,
    data: params.data,
    client: params.client,
    message,
    messageChannelId,
    author,
    sender,
    channelInfo,
    channelName,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    commandAuthorized,
    baseText,
    messageText,
    wasMentioned,
    route: effectiveRoute,
    threadBinding,
    boundSessionKey: boundSessionKey || undefined,
    boundAgentId,
    guildInfo,
    guildSlug,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    configChannelName,
    configChannelSlug,
    displayChannelName,
    displayChannelSlug,
    baseSessionKey,
    channelConfig,
    channelAllowlistConfigured,
    channelAllowed,
    shouldRequireMention,
    hasAnyMention,
    allowTextCommands,
    shouldBypassMention: mentionGate.shouldBypassMention,
    effectiveWasMentioned,
    canDetectMention,
    historyEntry,
    threadBindings: params.threadBindings,
    discordRestFetch: params.discordRestFetch,
  };
}
