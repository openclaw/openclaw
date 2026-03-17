import {
  ChannelType as CarbonChannelType,
  Command,
  CommandWithSubcommands
} from "@buape/carbon";
import {
  ApplicationCommandOptionType,
  ChannelType as DiscordChannelType
} from "discord-api-types/v10";
import { resolveCommandAuthorizedFromAuthorizers } from "../../../../src/channels/command-gating.js";
import { isDangerousNameMatchingEnabled } from "../../../../src/config/dangerous-name-matching.js";
import { formatMention } from "../mentions.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordOwnerAccess,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState
} from "../monitor/allow-list.js";
import { resolveDiscordChannelInfo } from "../monitor/message-utils.js";
import { resolveDiscordSenderIdentity } from "../monitor/sender-identity.js";
import { resolveDiscordThreadParentInfo } from "../monitor/threading.js";
const VOICE_CHANNEL_TYPES = [
  DiscordChannelType.GuildVoice,
  DiscordChannelType.GuildStageVoice
];
async function authorizeVoiceCommand(interaction, params, options) {
  const channelOverride = options?.channelOverride;
  const channel = channelOverride ? void 0 : interaction.channel;
  if (!interaction.guild) {
    return { ok: false, message: "Voice commands are only available in guilds." };
  }
  const user = interaction.user;
  if (!user) {
    return { ok: false, message: "Unable to resolve command user." };
  }
  const channelId = channelOverride?.id ?? channel?.id ?? "";
  const rawChannelName = channelOverride?.name ?? (channel && "name" in channel ? channel.name : void 0);
  const rawParentId = channelOverride?.parentId ?? ("parentId" in (channel ?? {}) ? channel.parentId ?? void 0 : void 0);
  const channelInfo = channelId ? await resolveDiscordChannelInfo(interaction.client, channelId) : null;
  const channelName = rawChannelName ?? channelInfo?.name;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const isThreadChannel = channelInfo?.type === CarbonChannelType.PublicThread || channelInfo?.type === CarbonChannelType.PrivateThread || channelInfo?.type === CarbonChannelType.AnnouncementThread;
  let parentId;
  let parentName;
  let parentSlug;
  if (isThreadChannel && channelId) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: channelId,
        name: channelName,
        parentId: rawParentId ?? channelInfo?.parentId,
        parent: void 0
      },
      channelInfo
    });
    parentId = parentInfo.id;
    parentName = parentInfo.name;
    parentSlug = parentName ? normalizeDiscordSlug(parentName) : void 0;
  }
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? void 0,
    guildId: interaction.guild?.id ?? interaction.rawData.guild_id ?? void 0,
    guildEntries: params.discordConfig.guilds
  });
  const channelConfig = channelId ? resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId,
    channelName,
    channelSlug,
    parentId,
    parentName,
    parentSlug,
    scope: isThreadChannel ? "thread" : "channel"
  }) : null;
  if (channelConfig?.enabled === false) {
    return { ok: false, message: "This channel is disabled." };
  }
  const channelAllowlistConfigured = Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (!isDiscordGroupAllowedByPolicy({
    groupPolicy: params.groupPolicy,
    guildAllowlisted: Boolean(guildInfo),
    channelAllowlistConfigured,
    channelAllowed
  }) || channelConfig?.allowed === false) {
    const channelId2 = channelOverride?.id ?? channel?.id;
    const channelLabel = channelId2 ? formatMention({ channelId: channelId2 }) : "This channel";
    return {
      ok: false,
      message: `${channelLabel} is not allowlisted for voice commands.`
    };
  }
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => String(roleId)) : [];
  const sender = resolveDiscordSenderIdentity({ author: user, member: interaction.rawData.member });
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender,
    allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig)
  });
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [],
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag
    },
    allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig)
  });
  const authorizers = params.useAccessGroups ? [
    { configured: ownerAllowList != null, allowed: ownerOk },
    { configured: hasAccessRestrictions, allowed: memberAllowed }
  ] : [{ configured: hasAccessRestrictions, allowed: memberAllowed }];
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers,
    modeWhenAccessGroupsOff: "configured"
  });
  if (!commandAuthorized) {
    return { ok: false, message: "You are not authorized to use this command." };
  }
  return { ok: true, guildId: interaction.guild.id };
}
async function resolveVoiceCommandRuntimeContext(interaction, params) {
  const guildId = interaction.guild?.id;
  if (!guildId) {
    await interaction.reply({
      content: "Unable to resolve guild for this command.",
      ephemeral: true
    });
    return null;
  }
  const manager = params.getManager();
  if (!manager) {
    await interaction.reply({
      content: "Voice manager is not available yet.",
      ephemeral: true
    });
    return null;
  }
  return { guildId, manager };
}
async function ensureVoiceCommandAccess(params) {
  const access = await authorizeVoiceCommand(params.interaction, params.context, {
    channelOverride: params.channelOverride
  });
  if (access.ok) {
    return true;
  }
  await params.interaction.reply({
    content: access.message ?? "Not authorized.",
    ephemeral: true
  });
  return false;
}
function createDiscordVoiceCommand(params) {
  const resolveSessionChannelId = (manager, guildId) => manager.status().find((entry) => entry.guildId === guildId)?.channelId;
  class JoinCommand extends Command {
    constructor() {
      super(...arguments);
      this.name = "join";
      this.description = "Join a voice channel";
      this.defer = true;
      this.ephemeral = params.ephemeralDefault;
      this.options = [
        {
          name: "channel",
          description: "Voice channel to join",
          type: ApplicationCommandOptionType.Channel,
          required: true,
          channel_types: VOICE_CHANNEL_TYPES
        }
      ];
    }
    async run(interaction) {
      const channel = await interaction.options.getChannel("channel", true);
      if (!channel || !("id" in channel)) {
        await interaction.reply({ content: "Voice channel not found.", ephemeral: true });
        return;
      }
      const access = await authorizeVoiceCommand(interaction, params, {
        channelOverride: {
          id: channel.id,
          name: "name" in channel ? channel.name : void 0,
          parentId: "parentId" in channel ? channel.parentId ?? void 0 : void 0
        }
      });
      if (!access.ok) {
        await interaction.reply({ content: access.message ?? "Not authorized.", ephemeral: true });
        return;
      }
      if (!isVoiceChannelType(channel.type)) {
        await interaction.reply({ content: "That is not a voice channel.", ephemeral: true });
        return;
      }
      const guildId = access.guildId ?? ("guildId" in channel ? channel.guildId : void 0);
      if (!guildId) {
        await interaction.reply({
          content: "Unable to resolve guild for this voice channel.",
          ephemeral: true
        });
        return;
      }
      const manager = params.getManager();
      if (!manager) {
        await interaction.reply({
          content: "Voice manager is not available yet.",
          ephemeral: true
        });
        return;
      }
      const result = await manager.join({ guildId, channelId: channel.id });
      await interaction.reply({ content: result.message, ephemeral: true });
    }
  }
  class LeaveCommand extends Command {
    constructor() {
      super(...arguments);
      this.name = "leave";
      this.description = "Leave the current voice channel";
      this.defer = true;
      this.ephemeral = params.ephemeralDefault;
    }
    async run(interaction) {
      const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
      if (!runtimeContext) {
        return;
      }
      const sessionChannelId = resolveSessionChannelId(
        runtimeContext.manager,
        runtimeContext.guildId
      );
      const authorized = await ensureVoiceCommandAccess({
        interaction,
        context: params,
        channelOverride: sessionChannelId ? { id: sessionChannelId } : void 0
      });
      if (!authorized) {
        return;
      }
      const result = await runtimeContext.manager.leave({ guildId: runtimeContext.guildId });
      await interaction.reply({ content: result.message, ephemeral: true });
    }
  }
  class StatusCommand extends Command {
    constructor() {
      super(...arguments);
      this.name = "status";
      this.description = "Show active voice sessions";
      this.defer = true;
      this.ephemeral = params.ephemeralDefault;
    }
    async run(interaction) {
      const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
      if (!runtimeContext) {
        return;
      }
      const sessions = runtimeContext.manager.status().filter((entry) => entry.guildId === runtimeContext.guildId);
      const sessionChannelId = sessions[0]?.channelId;
      const authorized = await ensureVoiceCommandAccess({
        interaction,
        context: params,
        channelOverride: sessionChannelId ? { id: sessionChannelId } : void 0
      });
      if (!authorized) {
        return;
      }
      if (sessions.length === 0) {
        await interaction.reply({ content: "No active voice sessions.", ephemeral: true });
        return;
      }
      const lines = sessions.map(
        (entry) => `\u2022 ${formatMention({ channelId: entry.channelId })} (guild ${entry.guildId})`
      );
      await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }
  }
  return new class extends CommandWithSubcommands {
    constructor() {
      super(...arguments);
      this.name = "vc";
      this.description = "Voice channel controls";
      this.subcommands = [new JoinCommand(), new LeaveCommand(), new StatusCommand()];
    }
  }();
}
function isVoiceChannelType(type) {
  return type === CarbonChannelType.GuildVoice || type === CarbonChannelType.GuildStageVoice;
}
export {
  createDiscordVoiceCommand
};
