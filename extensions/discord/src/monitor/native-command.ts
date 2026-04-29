import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/command-auth-native";
import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { buildPairingReply } from "openclaw/plugin-sdk/conversation-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  parseCommandArgs,
  resolveCommandArgMenu,
  serializeCommandArgs,
  type ChatCommandDefinition,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import * as pluginRuntime from "openclaw/plugin-sdk/plugin-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import {
  Button,
  Command,
  StringSelectMenu,
  type ButtonInteraction,
  type CommandInteraction,
  type CommandOptions,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import {
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordChannelPolicyCommandAuthorizer,
  resolveDiscordGuildEntry,
  resolveDiscordOwnerAccess,
} from "./allow-list.js";
import { resolveDiscordChannelTopicSafe } from "./channel-access.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import {
  resolveDiscordGuildNativeCommandAuthorized,
  resolveDiscordNativeAutocompleteAuthorized,
  resolveDiscordNativeCommandAllowlistAccess,
  resolveDiscordNativeGroupDmAccess,
} from "./native-command-auth.js";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";
import type { DispatchDiscordCommandInteractionResult } from "./native-command-dispatch.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
  isDiscordUnknownInteraction,
  safeDiscordInteractionCall,
} from "./native-command-reply.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import { maybeDeliverDiscordDirectStatus } from "./native-command-status.js";
import {
  buildDiscordCommandArgMenu,
  createDiscordCommandArgFallbackButton as createDiscordCommandArgFallbackButtonUi,
  createDiscordModelPickerFallbackButton as createDiscordModelPickerFallbackButtonUi,
  createDiscordModelPickerFallbackSelect as createDiscordModelPickerFallbackSelectUi,
  replyWithDiscordModelPickerProviders,
  resolveDiscordNativeChoiceContext,
  shouldOpenDiscordModelPickerFromCommand,
  type DiscordCommandArgContext,
  type DiscordModelPickerContext,
} from "./native-command-ui.js";
import { createNativeCommandDefinition, readDiscordCommandArgs } from "./native-command.args.js";
import {
  buildDiscordCommandOptions,
  truncateDiscordCommandDescription,
} from "./native-command.options.js";
import type { DiscordCommandArgs, DiscordConfig } from "./native-command.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

const log = createSubsystemLogger("discord/native-command");
let matchPluginCommandImpl = pluginRuntime.matchPluginCommand;
let executePluginCommandImpl = pluginRuntime.executePluginCommand;
let dispatchReplyWithDispatcherImpl = dispatchReplyWithDispatcher;
let resolveDirectStatusReplyForSessionImpl = resolveDirectStatusReplyForSession;
let resolveDiscordNativeInteractionRouteStateImpl = resolveDiscordNativeInteractionRouteState;

export const __testing = {
  setMatchPluginCommand(
    next: typeof pluginRuntime.matchPluginCommand,
  ): typeof pluginRuntime.matchPluginCommand {
    const previous = matchPluginCommandImpl;
    matchPluginCommandImpl = next;
    return previous;
  },
  setExecutePluginCommand(
    next: typeof pluginRuntime.executePluginCommand,
  ): typeof pluginRuntime.executePluginCommand {
    const previous = executePluginCommandImpl;
    executePluginCommandImpl = next;
    return previous;
  },
  setDispatchReplyWithDispatcher(
    next: typeof dispatchReplyWithDispatcher,
  ): typeof dispatchReplyWithDispatcher {
    const previous = dispatchReplyWithDispatcherImpl;
    dispatchReplyWithDispatcherImpl = next;
    return previous;
  },
  setResolveDirectStatusReplyForSession(
    next: typeof resolveDirectStatusReplyForSession,
  ): typeof resolveDirectStatusReplyForSession {
    const previous = resolveDirectStatusReplyForSessionImpl;
    resolveDirectStatusReplyForSessionImpl = next;
    return previous;
  },
  setResolveDiscordNativeInteractionRouteState(
    next: typeof resolveDiscordNativeInteractionRouteState,
  ): typeof resolveDiscordNativeInteractionRouteState {
    const previous = resolveDiscordNativeInteractionRouteStateImpl;
    resolveDiscordNativeInteractionRouteStateImpl = next;
    return previous;
  },
};

function shouldBypassConfiguredAcpEnsure(commandName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(commandName);
  // Recovery slash commands still need configured ACP readiness so stale dead
  // bindings are recreated before /new or /reset dispatches through them.
  return normalized === "acp";
}

function shouldBypassConfiguredAcpGuildGuards(commandName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(commandName);
  return normalized === "new" || normalized === "reset";
}

export function createDiscordNativeCommand(params: {
  command: NativeCommandSpec;
  cfg: OpenClawConfig;
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
  const fallbackCommandDefinition = createNativeCommandDefinition(command);
  const commandDefinition =
    matchPluginCommandImpl(`/${command.name}`) !== null
      ? fallbackCommandDefinition
      : (findCommandByNativeName(command.name, "discord", {
          includeBundledChannelFallback: false,
        }) ?? fallbackCommandDefinition);
  const argDefinitions = commandDefinition.args ?? command.args;
  const commandOptions = buildDiscordCommandOptions({
    command: commandDefinition,
    cfg,
    authorizeChoiceContext: async (interaction) =>
      await resolveDiscordNativeAutocompleteAuthorized({
        interaction,
        cfg,
        discordConfig,
        accountId,
      }),
    resolveChoiceContext: async (interaction) =>
      resolveDiscordNativeChoiceContext({
        interaction,
        cfg,
        accountId,
        threadBindings,
      }),
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
    description = truncateDiscordCommandDescription({
      value: command.description,
      label: `command:${command.name}`,
    });
    defer = false;
    ephemeral = ephemeralDefault;
    options = options;

    async run(interaction: CommandInteraction) {
      const deferred = await safeDiscordInteractionCall("interaction defer", () =>
        interaction.defer({ ephemeral: this.ephemeral }),
      );
      if (deferred === null) {
        return;
      }
      const commandArgs = argDefinitions?.length
        ? readDiscordCommandArgs(interaction, argDefinitions)
        : command.acceptsArgs
          ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "")
          : undefined;
      const commandArgsWithRaw = commandArgs
        ? ({
            ...commandArgs,
            raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw,
          } satisfies DiscordCommandArgs)
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
        // Slash commands are deferred up front, so all later responses must use
        // follow-up/edit semantics instead of the initial reply endpoint.
        preferFollowUp: true,
        threadBindings,
        responseEphemeral: ephemeralDefault,
      });
    }
  })();
}

async function dispatchDiscordCommandInteraction(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: DiscordCommandArgs;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
  threadBindings: ThreadBindingManager;
  responseEphemeral?: boolean;
  suppressReplies?: boolean;
}): Promise<DispatchDiscordCommandInteractionResult> {
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
    responseEphemeral,
    suppressReplies,
  } = params;
  const commandName = command.nativeName ?? command.key;
  const respond = async (content: string, options?: { ephemeral?: boolean }) => {
    const ephemeral = options?.ephemeral ?? responseEphemeral;
    const payload = {
      content,
      ...(ephemeral !== undefined ? { ephemeral } : {}),
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
    return { accepted: false };
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const channel = interaction.channel;
  const {
    isDirectMessage,
    isGroupDm,
    isThreadChannel,
    channelName,
    channelSlug,
    rawChannelId,
    threadParentId,
    threadParentName,
    threadParentSlug,
  } = await resolveDiscordNativeInteractionChannelContext({
    channel,
    client: interaction.client,
    hasGuild: Boolean(interaction.guild),
    channelIdFallback: "",
  });
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
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
    guildId: interaction.guild?.id,
  });
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildId: interaction.guild?.id ?? undefined,
    guildEntries: discordConfig?.guilds,
  });
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
  let nativeRouteStatePromise:
    | ReturnType<typeof resolveDiscordNativeInteractionRouteStateImpl>
    | undefined;
  const getNativeRouteState = () =>
    (nativeRouteStatePromise ??= resolveDiscordNativeInteractionRouteStateImpl({
      cfg,
      accountId,
      guildId: interaction.guild?.id ?? undefined,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      directUserId: user.id,
      conversationId: rawChannelId || "unknown",
      parentConversationId: threadParentId,
      threadBinding: isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : undefined,
      enforceConfiguredBindingReadiness: !shouldBypassConfiguredAcpEnsure(commandName),
    }));
  const canBypassConfiguredAcpGuildGuards = async () => {
    if (!interaction.guild || !shouldBypassConfiguredAcpGuildGuards(commandName)) {
      return false;
    }
    const routeState = await getNativeRouteState();
    return (
      routeState.effectiveRoute.matchedBy === "binding.channel" ||
      routeState.boundSessionKey != null ||
      routeState.configuredBinding != null ||
      routeState.configuredRoute != null
    );
  };
  if (channelConfig?.enabled === false && !(await canBypassConfiguredAcpGuildGuards())) {
    await respond("This channel is disabled.");
    return { accepted: false };
  }
  if (
    interaction.guild &&
    channelConfig?.allowed === false &&
    !(await canBypassConfiguredAcpGuildGuards())
  ) {
    await respond("This channel is not allowed.");
    return { accepted: false };
  }
  if (useAccessGroups && interaction.guild) {
    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.discord !== undefined,
      groupPolicy: discordConfig?.groupPolicy,
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
    });
    const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
      groupPolicy,
      guildInfo,
      channelConfig,
    });
    if (!policyAuthorizer.allowed && !(await canBypassConfiguredAcpGuildGuards())) {
      await respond("This channel is not allowed.");
      return { accepted: false };
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = discordConfig?.dmPolicy ?? discordConfig?.dm?.policy ?? "pairing";
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      await respond("Discord DMs are disabled.");
      return { accepted: false };
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
      return { accepted: false };
    }
  }
  const groupDmAccess = resolveDiscordNativeGroupDmAccess({
    isGroupDm,
    groupEnabled: discordConfig?.dm?.groupEnabled,
    groupChannels: discordConfig?.dm?.groupChannels,
    channelId: rawChannelId,
    channelName,
    channelSlug,
  });
  if (!groupDmAccess.allowed) {
    await respond(
      groupDmAccess.reason === "disabled"
        ? "Discord group DMs are disabled."
        : "This group DM is not allowed.",
    );
    return { accepted: false };
  }
  if (!isDirectMessage) {
    commandAuthorized = resolveDiscordGuildNativeCommandAuthorized({
      cfg,
      discordConfig,
      useAccessGroups,
      commandsAllowFromAccess,
      guildInfo,
      channelConfig,
      memberRoleIds,
      sender,
      allowNameMatching,
      ownerAllowListConfigured: ownerAllowList != null,
      ownerAllowed: ownerOk,
    });
    if (!commandAuthorized && !(await canBypassConfiguredAcpGuildGuards())) {
      await respond("You are not authorized to use this command.", { ephemeral: true });
      return { accepted: false };
    }
  }

  const menuNeedsModelContext =
    !(commandArgs?.raw && !commandArgs.values) &&
    command.args?.some(
      (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
    );
  const menuModelContext = menuNeedsModelContext
    ? await resolveDiscordNativeChoiceContext({
        interaction: interaction as CommandInteraction,
        cfg,
        accountId,
        threadBindings,
      })
    : null;
  const menu = resolveCommandArgMenu({
    command,
    args: commandArgs,
    cfg,
    provider: menuModelContext?.provider,
    model: menuModelContext?.model,
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
      return { accepted: true };
    }
    await safeDiscordInteractionCall("interaction reply", () =>
      interaction.reply({
        content: menuPayload.content,
        components: menuPayload.components,
        ephemeral: true,
      }),
    );
    return { accepted: true };
  }

  const pluginMatch = matchPluginCommandImpl(prompt);
  if (pluginMatch && commandName !== "status") {
    if (suppressReplies) {
      return { accepted: true };
    }
    const channelId = rawChannelId || "unknown";
    const messageThreadId = !isDirectMessage && isThreadChannel ? channelId : undefined;
    const pluginThreadParentId = !isDirectMessage && isThreadChannel ? threadParentId : undefined;
    const { effectiveRoute } = await getNativeRouteState();
    const pluginReply = await executePluginCommandImpl({
      command: pluginMatch.command,
      args: pluginMatch.args,
      senderId: sender.id,
      channel: "discord",
      channelId,
      isAuthorizedSender: commandAuthorized,
      sessionKey: effectiveRoute.sessionKey,
      commandBody: prompt,
      config: cfg,
      from: isDirectMessage
        ? `discord:${user.id}`
        : isGroupDm
          ? `discord:group:${channelId}`
          : `discord:channel:${channelId}`,
      to: `slash:${user.id}`,
      accountId,
      messageThreadId,
      threadParentId: pluginThreadParentId,
    });
    if (!hasRenderableReplyPayload(pluginReply)) {
      await respond("Done.");
      return { accepted: true, effectiveRoute };
    }
    await deliverDiscordInteractionReply({
      interaction,
      payload: pluginReply,
      textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
        fallbackLimit: 2000,
      }),
      maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
      preferFollowUp,
      responseEphemeral,
      chunkMode: resolveChunkMode(cfg, "discord", accountId),
    });
    return { accepted: true, effectiveRoute };
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
    return { accepted: true };
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
  const interactionId = interaction.rawData.id;
  const routeState = await getNativeRouteState();
  if (routeState.bindingReadiness && !routeState.bindingReadiness.ok) {
    const configuredBinding = routeState.configuredBinding;
    if (configuredBinding) {
      logVerbose(
        `discord native command: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${routeState.bindingReadiness.error}`,
      );
      await respond("Configured ACP binding is unavailable right now. Please try again.");
      return { accepted: false };
    }
  }
  const boundSessionKey = routeState.boundSessionKey;
  const effectiveRoute = routeState.effectiveRoute;
  const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
    agentId: effectiveRoute.agentId,
    sessionPrefix,
    userId: user.id,
    targetSessionKey: effectiveRoute.sessionKey,
    boundSessionKey,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);
  const directStatusResult = await maybeDeliverDiscordDirectStatus({
    commandName,
    suppressReplies,
    resolveDirectStatusReplyForSession: resolveDirectStatusReplyForSessionImpl,
    cfg,
    discordConfig,
    accountId,
    sessionKey,
    commandTargetSessionKey,
    channel: "discord",
    senderId: sender.id,
    senderIsOwner: ownerOk,
    isAuthorizedSender: commandAuthorized,
    isGroup: isGuild || isGroupDm,
    defaultGroupActivation: () =>
      !isGuild ? "always" : channelConfig?.requireMention === false ? "always" : "mention",
    interaction,
    mediaLocalRoots,
    preferFollowUp,
    responseEphemeral,
    effectiveRoute,
    respond,
  });
  if (directStatusResult) {
    return directStatusResult;
  }
  const ctxPayload = buildDiscordNativeCommandContext({
    prompt,
    commandArgs: commandArgs ?? {},
    sessionKey,
    commandTargetSessionKey,
    accountId: effectiveRoute.accountId,
    interactionId,
    channelId,
    threadParentId,
    memberRoleIds,
    guildId: interaction.guild?.id,
    guildName: interaction.guild?.name,
    channelTopic: resolveDiscordChannelTopicSafe(channel),
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

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: effectiveRoute.agentId,
    channel: "discord",
    accountId: effectiveRoute.accountId,
  });
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);

  let didReply = false;
  const dispatchResult = await dispatchReplyWithDispatcherImpl({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...replyPipeline,
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
            responseEphemeral,
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
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
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
  return { accepted: true, effectiveRoute };
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
