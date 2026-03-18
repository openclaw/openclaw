import {
  Button,
  ChannelType,
  Command,
  StringSelectMenu,
  type TopLevelComponents,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  type CommandOptions,
  type StringSelectMenuInteraction,
} from "@buape/carbon";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/channel-runtime";
import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/channel-runtime";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/config-runtime";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { buildPairingReply } from "openclaw/plugin-sdk/conversation-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { executePluginCommand, matchPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
  NativeCommandSpec,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  serializeCommandArgs,
} from "openclaw/plugin-sdk/reply-runtime";
import { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordAllowListMatch,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";
import {
  buildDiscordCommandArgMenu,
  createDiscordCommandArgFallbackButton as createDiscordCommandArgFallbackButtonUi,
  createDiscordModelPickerFallbackButton as createDiscordModelPickerFallbackButtonUi,
  createDiscordModelPickerFallbackSelect as createDiscordModelPickerFallbackSelectUi,
  replyWithDiscordModelPickerProviders,
  shouldOpenDiscordModelPickerFromCommand,
  type DiscordCommandArgContext,
  type DiscordModelPickerContext,
} from "./native-command-ui.js";
import {
  resolveDiscordBoundConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import type { ThreadBindingManager } from "./thread-bindings.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
const log = createSubsystemLogger("discord/native-command");

function resolveDiscordNativeCommandAllowlistAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  sender: { id: string; name?: string; tag?: string };
  chatType: "direct" | "group" | "thread" | "channel";
  conversationId?: string;
}) {
  const commandsAllowFrom = params.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return { configured: false, allowed: false } as const;
  }
  const rawAllowList = Array.isArray(commandsAllowFrom.discord)
    ? commandsAllowFrom.discord
    : commandsAllowFrom["*"];
  if (!Array.isArray(rawAllowList)) {
    return { configured: false, allowed: false } as const;
  }
  const allowList = normalizeDiscordAllowList(rawAllowList.map(String), [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return { configured: true, allowed: false } as const;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: params.sender,
    allowNameMatching: false,
  });
  return { configured: true, allowed: match.allowed } as const;
}

function buildDiscordCommandOptions(params: {
  command: ChatCommandDefinition;
  cfg: ReturnType<typeof loadConfig>;
}): CommandOptions | undefined {
  const { command, cfg } = params;
  const args = command.args;
  if (!args || args.length === 0) {
    return undefined;
  }
  return args.map((arg) => {
    const required = arg.required ?? false;
    if (arg.type === "number") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Number,
        required,
      };
    }
    if (arg.type === "boolean") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Boolean,
        required,
      };
    }
    const resolvedChoices = resolveCommandArgChoices({ command, arg, cfg });
    const shouldAutocomplete =
      arg.preferAutocomplete === true ||
      (resolvedChoices.length > 0 &&
        (typeof arg.choices === "function" || resolvedChoices.length > 25));
    const autocomplete = shouldAutocomplete
      ? async (interaction: AutocompleteInteraction) => {
          const focused = interaction.options.getFocused();
          const focusValue =
            typeof focused?.value === "string" ? focused.value.trim().toLowerCase() : "";
          const choices = resolveCommandArgChoices({ command, arg, cfg });
          const filtered = focusValue
            ? choices.filter((choice) => choice.label.toLowerCase().includes(focusValue))
            : choices;
          await interaction.respond(
            filtered.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.value })),
          );
        }
      : undefined;
    const choices =
      resolvedChoices.length > 0 && !autocomplete
        ? resolvedChoices
            .slice(0, 25)
            .map((choice) => ({ name: choice.label, value: choice.value }))
        : undefined;
    return {
      name: arg.name,
      description: arg.description,
      type: ApplicationCommandOptionType.String,
      required,
      choices,
      autocomplete,
    };
  }) satisfies CommandOptions;
}

function shouldBypassConfiguredAcpEnsure(commandName: string): boolean {
  const normalized = commandName.trim().toLowerCase();
  return normalized === "acp" || normalized === "new" || normalized === "reset";
}

function readDiscordCommandArgs(
  interaction: CommandInteraction,
  definitions?: CommandArgDefinition[],
): CommandArgs | undefined {
  if (!definitions || definitions.length === 0) {
    return undefined;
  }
  const values: CommandArgValues = {};
  for (const definition of definitions) {
    let value: string | number | boolean | null | undefined;
    if (definition.type === "number") {
      value = interaction.options.getNumber(definition.name) ?? null;
    } else if (definition.type === "boolean") {
      value = interaction.options.getBoolean(definition.name) ?? null;
    } else {
      value = interaction.options.getString(definition.name) ?? null;
    }
    if (value != null) {
      values[definition.name] = value;
    }
  }
  return Object.keys(values).length > 0 ? { values } : undefined;
}

function isDiscordUnknownInteraction(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as {
    discordCode?: number;
    status?: number;
    message?: string;
    rawBody?: { code?: number; message?: string };
  };
  if (err.discordCode === 10062 || err.rawBody?.code === 10062) {
    return true;
  }
  if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) {
    return true;
  }
  if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) {
    return true;
  }
  return false;
}

function hasRenderableReplyPayload(payload: ReplyPayload): boolean {
  if (resolveSendableOutboundReplyParts(payload).hasContent) {
    return true;
  }
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[] }
    | undefined;
  if (Array.isArray(discordData?.components) && discordData.components.length > 0) {
    return true;
  }
  return false;
}

async function safeDiscordInteractionCall<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isDiscordUnknownInteraction(error)) {
      logVerbose(`discord: ${label} skipped (interaction expired)`);
      return null;
    }
    throw error;
  }
}

export function createDiscordNativeCommand(params: {
  command: NativeCommandSpec;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
  threadBindings: ThreadBindingManager;
}): Command {
  const {
    command,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    ephemeralDefault,
    threadBindings,
  } = params;
  const commandDefinition =
    findCommandByNativeName(command.name, "discord") ??
    ({
      key: command.name,
      nativeName: command.name,
      description: command.description,
      textAliases: [],
      acceptsArgs: command.acceptsArgs,
      args: command.args,
      argsParsing: "none",
      scope: "native",
    } satisfies ChatCommandDefinition);
  const argDefinitions = commandDefinition.args ?? command.args;
  const commandOptions = buildDiscordCommandOptions({
    command: commandDefinition,
    cfg,
  });
  const options = commandOptions
    ? (commandOptions satisfies CommandOptions)
    : command.acceptsArgs
      ? ([
          {
            name: "input",
            description: "Command input",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ] satisfies CommandOptions)
      : undefined;

  return new (class extends Command {
    name = command.name;
    description = command.description;
    defer = true;
    ephemeral = ephemeralDefault;
    options = options;

    async run(interaction: CommandInteraction) {
      const commandArgs = argDefinitions?.length
        ? readDiscordCommandArgs(interaction, argDefinitions)
        : command.acceptsArgs
          ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "")
          : undefined;
      const commandArgsWithRaw = commandArgs
        ? ({
            ...commandArgs,
            raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw,
          } satisfies CommandArgs)
        : undefined;
      const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
      await dispatchDiscordCommandInteraction({
        interaction,
        prompt,
        command: commandDefinition,
        commandArgs: commandArgsWithRaw,
        cfg,
        discordConfig,
        accountId,
        sessionPrefix,
        preferFollowUp: false,
        threadBindings,
      });
    }
  })();
}

async function dispatchDiscordCommandInteraction(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
  threadBindings: ThreadBindingManager;
  suppressReplies?: boolean;
}) {
  const {
    interaction,
    prompt,
    command,
    commandArgs,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    preferFollowUp,
    threadBindings,
    suppressReplies,
  } = params;
  const respond = async (content: string, options?: { ephemeral?: boolean }) => {
    const payload = {
      content,
      ...(options?.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
    };
    await safeDiscordInteractionCall("interaction reply", async () => {
      if (preferFollowUp) {
        await interaction.followUp(payload);
        return;
      }
      await interaction.reply(payload);
    });
  };

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const user = interaction.user;
  if (!user) {
    return;
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const channel = interaction.channel;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const channelName = channel && "name" in channel ? (channel.name as string) : undefined;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const rawChannelId = channel?.id ?? "";
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => String(roleId))
    : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
    allowNameMatching,
  });
  const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
    cfg,
    accountId,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
    chatType: isDirectMessage
      ? "direct"
      : isThreadChannel
        ? "thread"
        : interaction.guild
          ? "channel"
          : "group",
    conversationId: rawChannelId || undefined,
  });
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildId: interaction.guild?.id ?? undefined,
    guildEntries: discordConfig?.guilds,
  });
  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    // Threads inherit parent channel config unless explicitly overridden.
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: channelName,
        parentId: "parentId" in channel ? (channel.parentId ?? undefined) : undefined,
        parent: undefined,
      },
      channelInfo,
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }
  const channelConfig = interaction.guild
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: rawChannelId,
        channelName,
        channelSlug,
        parentId: threadParentId,
        parentName: threadParentName,
        parentSlug: threadParentSlug,
        scope: isThreadChannel ? "thread" : "channel",
      })
    : null;
  if (channelConfig?.enabled === false) {
    await respond("This channel is disabled.");
    return;
  }
  if (interaction.guild && channelConfig?.allowed === false) {
    await respond("This channel is not allowed.");
    return;
  }
  if (useAccessGroups && interaction.guild) {
    const channelAllowlistConfigured =
      Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
    const channelAllowed = channelConfig?.allowed !== false;
    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.discord !== undefined,
      groupPolicy: discordConfig?.groupPolicy,
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
    });
    const allowByPolicy = isDiscordGroupAllowedByPolicy({
      groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    });
    if (!allowByPolicy) {
      await respond("This channel is not allowed.");
      return;
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = discordConfig?.dmPolicy ?? discordConfig?.dm?.policy ?? "pairing";
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      await respond("Discord DMs are disabled.");
      return;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId,
      dmPolicy,
      configuredAllowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
      useAccessGroups,
    });
    commandAuthorized = dmAccess.commandAuthorized;
    if (dmAccess.decision !== "allow") {
      await handleDiscordDmCommandDecision({
        dmAccess,
        accountId,
        sender: {
          id: user.id,
          tag: sender.tag,
          name: sender.name,
        },
        onPairingCreated: async (code) => {
          await respond(
            buildPairingReply({
              channel: "discord",
              idLine: `Your Discord user id: ${user.id}`,
              code,
            }),
            { ephemeral: true },
          );
        },
        onUnauthorized: async () => {
          await respond("You are not authorized to use this command.", { ephemeral: true });
        },
      });
      return;
    }
  }
  if (!isDirectMessage) {
    const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
      channelConfig,
      guildInfo,
      memberRoleIds,
      sender,
      allowNameMatching,
    });
    const authorizers = useAccessGroups
      ? [
          {
            configured: commandsAllowFromAccess.configured,
            allowed: commandsAllowFromAccess.allowed,
          },
          { configured: ownerAllowList != null, allowed: ownerOk },
          { configured: hasAccessRestrictions, allowed: memberAllowed },
        ]
      : [
          {
            configured: commandsAllowFromAccess.configured,
            allowed: commandsAllowFromAccess.allowed,
          },
          { configured: hasAccessRestrictions, allowed: memberAllowed },
        ];
    commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers,
      modeWhenAccessGroupsOff: "configured",
    });
    if (!commandAuthorized) {
      await respond("You are not authorized to use this command.", { ephemeral: true });
      return;
    }
  }
  if (isGroupDm && discordConfig?.dm?.groupEnabled === false) {
    await respond("Discord group DMs are disabled.");
    return;
  }

  const menu = resolveCommandArgMenu({
    command,
    args: commandArgs,
    cfg,
  });
  if (menu) {
    const menuPayload = buildDiscordCommandArgMenu({
      command,
      menu,
      interaction: interaction as CommandInteraction,
      ctx: {
        cfg,
        discordConfig,
        accountId,
        sessionPrefix,
        threadBindings,
      },
      safeInteractionCall: safeDiscordInteractionCall,
      dispatchCommandInteraction: dispatchDiscordCommandInteraction,
    });
    if (preferFollowUp) {
      await safeDiscordInteractionCall("interaction follow-up", () =>
        interaction.followUp({
          content: menuPayload.content,
          components: menuPayload.components,
          ephemeral: true,
        }),
      );
      return;
    }
    await safeDiscordInteractionCall("interaction reply", () =>
      interaction.reply({
        content: menuPayload.content,
        components: menuPayload.components,
        ephemeral: true,
      }),
    );
    return;
  }

  const pluginMatch = matchPluginCommand(prompt);
  if (pluginMatch) {
    if (suppressReplies) {
      return;
    }
    const channelId = rawChannelId || "unknown";
    const pluginReply = await executePluginCommand({
      command: pluginMatch.command,
      args: pluginMatch.args,
      senderId: sender.id,
      channel: "discord",
      channelId,
      isAuthorizedSender: commandAuthorized,
      commandBody: prompt,
      config: cfg,
      from: isDirectMessage
        ? `discord:${user.id}`
        : isGroupDm
          ? `discord:group:${channelId}`
          : `discord:channel:${channelId}`,
      to: `slash:${user.id}`,
      accountId,
    });
    if (!hasRenderableReplyPayload(pluginReply)) {
      await respond("Done.");
      return;
    }
    await deliverDiscordInteractionReply({
      interaction,
      payload: pluginReply,
      textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
        fallbackLimit: 2000,
      }),
      maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
      preferFollowUp,
      chunkMode: resolveChunkMode(cfg, "discord", accountId),
    });
    return;
  }

  const pickerCommandContext = shouldOpenDiscordModelPickerFromCommand({
    command,
    commandArgs,
  });
  if (pickerCommandContext) {
    await replyWithDiscordModelPickerProviders({
      interaction,
      cfg,
      command: pickerCommandContext,
      userId: user.id,
      accountId,
      threadBindings,
      preferFollowUp,
      safeInteractionCall: safeDiscordInteractionCall,
    });
    return;
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
  const interactionId = interaction.rawData.id;
  const route = resolveDiscordBoundConversationRoute({
    cfg,
    accountId,
    guildId: interaction.guild?.id ?? undefined,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    directUserId: user.id,
    conversationId: channelId,
    parentConversationId: threadParentId,
    // Configured ACP routes apply after raw route resolution, so do not pass
    // bound/configured overrides here.
  });
  const threadBinding = isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : undefined;
  const configuredRoute =
    threadBinding == null
      ? resolveConfiguredBindingRoute({
          cfg,
          route,
          conversation: {
            channel: "discord",
            accountId,
            conversationId: channelId,
            parentConversationId: threadParentId,
          },
        })
      : null;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  const commandName = command.nativeName ?? command.key;
  if (configuredBinding && !shouldBypassConfiguredAcpEnsure(commandName)) {
    const ensured = await ensureConfiguredBindingRouteReady({
      cfg,
      bindingResolution: configuredBinding,
    });
    if (!ensured.ok) {
      logVerbose(
        `discord native command: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
      );
      await respond("Configured ACP binding is unavailable right now. Please try again.");
      return;
    }
  }
  const configuredBoundSessionKey = configuredRoute?.boundSessionKey?.trim() || undefined;
  const boundSessionKey = threadBinding?.targetSessionKey?.trim() || configuredBoundSessionKey;
  const effectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: configuredBinding ? "binding.channel" : undefined,
  });
  const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
    agentId: effectiveRoute.agentId,
    sessionPrefix,
    userId: user.id,
    targetSessionKey: effectiveRoute.sessionKey,
    boundSessionKey,
  });
  const ctxPayload = buildDiscordNativeCommandContext({
    prompt,
    commandArgs: commandArgs ?? {},
    sessionKey,
    commandTargetSessionKey,
    accountId: effectiveRoute.accountId,
    interactionId,
    channelId,
    threadParentId,
    guildName: interaction.guild?.name,
    channelTopic: channel && "topic" in channel ? (channel.topic ?? undefined) : undefined,
    channelConfig,
    guildInfo,
    allowNameMatching,
    commandAuthorized,
    isDirectMessage,
    isGroupDm,
    isGuild,
    isThreadChannel,
    user: {
      id: user.id,
      username: user.username,
      globalName: user.globalName,
    },
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: effectiveRoute.agentId,
    channel: "discord",
    accountId: effectiveRoute.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);

  let didReply = false;
  const dispatchResult = await dispatchReplyWithDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(cfg, effectiveRoute.agentId),
      deliver: async (payload) => {
        if (suppressReplies) {
          return;
        }
        try {
          await deliverDiscordInteractionReply({
            interaction,
            payload,
            mediaLocalRoots,
            textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
              fallbackLimit: 2000,
            }),
            maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
            preferFollowUp: preferFollowUp || didReply,
            chunkMode: resolveChunkMode(cfg, "discord", accountId),
          });
        } catch (error) {
          if (isDiscordUnknownInteraction(error)) {
            logVerbose("discord: interaction reply skipped (interaction expired)");
            return;
          }
          throw error;
        }
        didReply = true;
      },
      onError: (err, info) => {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        log.error(`discord slash ${info.kind} reply failed: ${message}`);
      },
    },
    replyOptions: {
      skillFilter: channelConfig?.skills,
      disableBlockStreaming:
        typeof discordConfig?.blockStreaming === "boolean"
          ? !discordConfig.blockStreaming
          : undefined,
      onModelSelected,
    },
  });

  // Fallback: if the agent turn produced no deliverable replies (for example,
  // a skill only used message.send side effects), close the interaction with
  // a minimal acknowledgment so Discord does not stay in a pending state.
  if (
    !suppressReplies &&
    !didReply &&
    dispatchResult.counts.final === 0 &&
    dispatchResult.counts.block === 0 &&
    dispatchResult.counts.tool === 0
  ) {
    await safeDiscordInteractionCall("interaction empty fallback", async () => {
      const payload = {
        content: "✅ Done.",
        ephemeral: true,
      };
      if (preferFollowUp) {
        await interaction.followUp(payload);
        return;
      }
      await interaction.reply(payload);
    });
  }
}

export function createDiscordCommandArgFallbackButton(params: DiscordCommandArgContext): Button {
  return createDiscordCommandArgFallbackButtonUi({
    ctx: params,
    safeInteractionCall: safeDiscordInteractionCall,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
  });
}

export function createDiscordModelPickerFallbackButton(params: DiscordModelPickerContext): Button {
  return createDiscordModelPickerFallbackButtonUi({
    ctx: params,
    safeInteractionCall: safeDiscordInteractionCall,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
  });
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerContext,
): StringSelectMenu {
  return createDiscordModelPickerFallbackSelectUi({
    ctx: params,
    safeInteractionCall: safeDiscordInteractionCall,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
  });
}

async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  payload: ReplyPayload;
  mediaLocalRoots?: readonly string[];
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
  chunkMode: "length" | "newline";
}) {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
  const reply = resolveSendableOutboundReplyParts(payload);
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[] }
    | undefined;
  let firstMessageComponents =
    Array.isArray(discordData?.components) && discordData.components.length > 0
      ? discordData.components
      : undefined;

  let hasReplied = false;
  const sendMessage = async (
    content: string,
    files?: { name: string; data: Buffer }[],
    components?: TopLevelComponents[],
  ) => {
    const payload =
      files && files.length > 0
        ? {
            content,
            ...(components ? { components } : {}),
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { name: file.name, data: file.data };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { name: file.name, data: new Blob([arrayBuffer]) };
            }),
          }
        : {
            content,
            ...(components ? { components } : {}),
          };
    await safeDiscordInteractionCall("interaction send", async () => {
      if (!preferFollowUp && !hasReplied) {
        await interaction.reply(payload);
        hasReplied = true;
        firstMessageComponents = undefined;
        return;
      }
      await interaction.followUp(payload);
      hasReplied = true;
      firstMessageComponents = undefined;
    });
  };

  if (reply.hasMedia) {
    const media = await Promise.all(
      reply.mediaUrls.map(async (url) => {
        const loaded = await loadWebMedia(url, {
          localRoots: params.mediaLocalRoots,
        });
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
        };
      }),
    );
    const chunks = resolveTextChunksWithFallback(
      reply.text,
      chunkDiscordTextWithMode(reply.text, {
        maxChars: textLimit,
        maxLines: maxLinesPerMessage,
        chunkMode,
      }),
    );
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media, firstMessageComponents);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) {
        continue;
      }
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (!reply.hasText && !firstMessageComponents) {
    return;
  }
  const chunks =
    reply.text || firstMessageComponents
      ? resolveTextChunksWithFallback(
          reply.text,
          chunkDiscordTextWithMode(reply.text, {
            maxChars: textLimit,
            maxLines: maxLinesPerMessage,
            chunkMode,
          }),
        )
      : [];
  for (const chunk of chunks) {
    if (!chunk.trim() && !firstMessageComponents) {
      continue;
    }
    await sendMessage(chunk, undefined, firstMessageComponents);
  }
}
