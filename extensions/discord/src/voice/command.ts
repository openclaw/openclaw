import {
  ApplicationCommandOptionType,
  ChannelType as DiscordChannelType,
  type APIApplicationCommandChannelOption,
} from "discord-api-types/v10";
import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import {
  Command,
  CommandWithSubcommands,
  type CommandInteraction,
  type CommandOptions,
} from "../internal/discord.js";
import { formatMention } from "../mentions.js";
import { resolveDiscordChannelNameSafe } from "../monitor/channel-access.js";
import {
  createDiscordLivePolicyReader,
  type DiscordLivePolicyReader,
} from "../monitor/live-policy.js";
import { resolveDiscordSenderIdentity } from "../monitor/sender-identity.js";
import { resolveDiscordThreadLikeChannelContext } from "../monitor/thread-channel-context.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import { resolveDiscordVoiceAccess } from "./owner-access.js";
import { isVoiceChannel } from "./session.js";
import type { DiscordVoiceManager } from "./voice-runtime.js";

const VOICE_CHANNEL_TYPES: NonNullable<APIApplicationCommandChannelOption["channel_types"]> = [
  DiscordChannelType.GuildVoice,
  DiscordChannelType.GuildStageVoice,
];

export const DISCORD_VOICE_COMMAND_SPEC = {
  name: "vc",
  description: "Voice channel controls",
  acceptsArgs: false,
} satisfies NativeCommandSpec;

type VoiceCommandContext = {
  readPolicy?: DiscordLivePolicyReader;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
  groupPolicy: "open" | "disabled" | "allowlist";
  getManager: () => DiscordVoiceManager | null;
  ephemeralDefault: boolean;
};

type VoiceCommandChannelOverride = {
  id: string;
  name?: string;
  parentId?: string;
};

async function authorizeVoiceCommand(
  interaction: CommandInteraction,
  params: VoiceCommandContext,
  options?: { channelOverride?: VoiceCommandChannelOverride },
): Promise<{ ok: true; guildId: string } | { ok: false; message: string }> {
  const channelOverride = options?.channelOverride;
  const channel = channelOverride ? undefined : interaction.channel;
  if (!interaction.guild) {
    return { ok: false, message: "Voice commands are only available in guilds." };
  }
  const user = interaction.user;
  if (!user) {
    return { ok: false, message: "Unable to resolve command user." };
  }

  const channelId = channelOverride?.id ?? channel?.id ?? "";
  const channelContext = await resolveDiscordThreadLikeChannelContext({
    client: interaction.client,
    channel: channelOverride ?? channel,
    channelIdFallback: channelId,
  });
  const channelName = channelOverride?.name ?? channelContext.channelName;

  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.slice()
    : [];
  const sender = resolveDiscordSenderIdentity({ author: user, member: interaction.rawData.member });
  const policy = await params.readPolicy?.();
  if (policy?.isCurrent() === false) {
    return { ok: false, message: "Access policy changed. Try this interaction again." };
  }
  const currentParams = { ...params, ...policy };
  const voiceAccess = resolveDiscordVoiceAccess(currentParams);
  const access = await authorizeDiscordVoiceIngress({
    cfg: currentParams.cfg,
    discordConfig: currentParams.discordConfig,
    accountId: currentParams.accountId,
    groupPolicy: currentParams.groupPolicy,
    guild: interaction.guild,
    guildId: interaction.guild.id,
    channelId,
    channelName,
    channelSlug: channelContext.channelSlug,
    parentId: channelOverride?.parentId ?? channelContext.threadParentId,
    parentName: channelContext.threadParentName,
    parentSlug: channelContext.threadParentSlug,
    scope: channelContext.isThreadChannel ? "thread" : "channel",
    channelLabel: channelId ? formatMention({ channelId }) : "This channel",
    memberRoleIds,
    admissionAllowFrom: voiceAccess.admissionAllowFrom,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
  });
  if (!access.ok) {
    return { ok: false, message: access.message };
  }

  return { ok: true, guildId: interaction.guild.id };
}

export function createDiscordVoiceCommand(
  startupParams: VoiceCommandContext,
): CommandWithSubcommands {
  const params = {
    ...startupParams,
    readPolicy:
      startupParams.readPolicy ??
      createDiscordLivePolicyReader({
        ...startupParams,
        discordConfig: { ...startupParams.discordConfig, groupPolicy: startupParams.groupPolicy },
        resolvedAllowlist: {
          guildEntries: startupParams.discordConfig.guilds,
          allowFrom: startupParams.discordConfig.allowFrom,
        },
      }),
  };
  abstract class VoiceCommand extends Command {
    override defer = true;
    override ephemeral = params.ephemeralDefault;

    protected abstract execute(interaction: CommandInteraction): Promise<string>;

    async run(interaction: CommandInteraction) {
      const content = await this.execute(interaction);
      await interaction.reply({ content, ephemeral: true });
    }
  }

  class JoinCommand extends VoiceCommand {
    override name = "join";
    override description = "Join a voice channel";
    override options: CommandOptions = [
      {
        name: "channel",
        description: "Voice channel to join",
        type: ApplicationCommandOptionType.Channel,
        required: true,
        channel_types: VOICE_CHANNEL_TYPES,
      },
    ];

    protected async execute(interaction: CommandInteraction): Promise<string> {
      const channel = await interaction.options.getChannel("channel", true);
      if (!channel || !("id" in channel)) {
        return "Voice channel not found.";
      }

      const access = await authorizeVoiceCommand(interaction, params, {
        channelOverride: {
          id: channel.id,
          name: resolveDiscordChannelNameSafe(channel),
        },
      });
      if (!access.ok) {
        return access.message;
      }
      if (!isVoiceChannel(channel.type)) {
        return "That is not a voice channel.";
      }
      const manager = params.getManager();
      if (!manager) {
        return "Voice manager is not available yet.";
      }

      const result = await manager.join({ guildId: access.guildId, channelId: channel.id });
      return result.message;
    }
  }

  class SessionCommand extends VoiceCommand {
    override description: string;

    constructor(override name: "leave" | "status") {
      super();
      this.description =
        name === "leave" ? "Leave the current voice channel" : "Show active voice sessions";
    }

    protected async execute(interaction: CommandInteraction): Promise<string> {
      const guildId = interaction.guild?.id;
      if (!guildId) {
        return "Unable to resolve guild for this command.";
      }
      const manager = params.getManager();
      if (!manager) {
        return "Voice manager is not available yet.";
      }
      const sessions = manager.status().filter((entry) => entry.guildId === guildId);
      const sessionChannelId = sessions[0]?.channelId;
      const access = await authorizeVoiceCommand(interaction, params, {
        channelOverride: sessionChannelId ? { id: sessionChannelId } : undefined,
      });
      if (!access.ok) {
        return access.message;
      }
      if (this.name === "leave") {
        const result = await manager.leave({ guildId });
        return result.message;
      }
      if (sessions.length === 0) {
        return "No active voice sessions.";
      }
      const lines = sessions.map(
        (entry) =>
          `• ${formatMention({ channelId: entry.channelId })} (guild ${entry.guildId})${entry.warning ? `\n${entry.warning}` : ""}`,
      );
      return lines.join("\n");
    }
  }

  return new (class extends CommandWithSubcommands {
    override name = DISCORD_VOICE_COMMAND_SPEC.name;
    override description = DISCORD_VOICE_COMMAND_SPEC.description;
    subcommands = [new JoinCommand(), new SessionCommand("leave"), new SessionCommand("status")];
  })();
}
