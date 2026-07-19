// Discord plugin module implements native command behavior.
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { loadModelCatalog } from "openclaw/plugin-sdk/agent-runtime";
import {
  authorizeNativeCoreCommand,
  resolveNativeCommandSessionTargets,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
  resolveDiscordMaxLinesPerMessage,
} from "../accounts.js";
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
  resolveDiscordCommandOwnerAllowFrom,
  resolveDiscordChannelPolicyCommandAuthorizer,
  resolveDiscordOwnerAccess,
} from "./allow-list.js";
import { resolveDiscordChannelTopicSafe } from "./channel-access.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { dispatchDiscordNativeAgentReply } from "./native-command-agent-reply.js";
import {
  resolveDiscordGuildNativeCommandAuthorized,
  resolveDiscordNativeAutocompleteAuthorized,
  resolveDiscordNativeCommandChannelAccessContext,
  resolveDiscordNativeGroupDmAccess,
} from "./native-command-auth.js";
import {
  shouldBypassConfiguredAcpEnsure,
  shouldBypassConfiguredAcpGuildGuards,
} from "./native-command-bypass.js";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";
import type { DispatchDiscordCommandInteractionResult } from "./native-command-dispatch.js";
import {
  DISCORD_EMPTY_VISIBLE_REPLY_WARNING,
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
  safeDiscordInteractionCall,
} from "./native-command-reply.js";
import {
  resolveDiscordNativeBindingTarget,
  resolveDiscordNativeBoundRoute,
} from "./native-command-route.js";
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
  truncateDiscordCommandDescriptionLocalizations,
  truncateDiscordCommandDescription,
} from "./native-command.options.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import type { DiscordCommandArgs, DiscordConfig } from "./native-command.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

const log = createSubsystemLogger("discord/native-command");
const NATIVE_PLUGIN_CONTINUATION_COMMAND_BODY = "[native plugin command already handled]";

export function createDiscordNativeCommand(params: {
  command: NativeCommandSpec;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
  threadBindings: ThreadBindingManager;
}): Command {
  const { command, cfg, accountId, sessionPrefix, ephemeralDefault, threadBindings } = params;
  const fallbackCommandDefinition = createNativeCommandDefinition(command);
  const pluginCommandMatch = nativeCommandRuntime.matchPluginCommand(`/${command.name}`);
  const commandDefinition =
    pluginCommandMatch !== null
      ? fallbackCommandDefinition
      : (findCommandByNativeName(command.name, "discord", {
          includeBundledChannelFallback: false,
        }) ?? fallbackCommandDefinition);
  const argDefinitions = commandDefinition.args ?? command.args;
  const resolveCurrentConfig = () => getRuntimeConfigSnapshot() ?? cfg;
  const commandOptions = buildDiscordCommandOptions({
    command: commandDefinition,
    cfg,
    resolveConfig: resolveCurrentConfig,
    authorizeChoiceContext: async (interaction) => {
      const currentConfig = resolveCurrentConfig();
      return await resolveDiscordNativeAutocompleteAuthorized({
        interaction,
        cfg: currentConfig,
        discordConfig: mergeDiscordAccountConfig(currentConfig, accountId),
        accountId,
        skipCommandOwnerAllowFrom: pluginCommandMatch !== null,
      });
    },
    resolveChoiceContext: async (interaction) =>
      resolveDiscordNativeChoiceContext({
        interaction,
        cfg: resolveCurrentConfig(),
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
    override name = command.name;
    override description = truncateDiscordCommandDescription({
      value: command.description,
      label: `command:${command.name}`,
    });
    override descriptionLocalizations = truncateDiscordCommandDescriptionLocalizations({
      value: command.descriptionLocalizations,
      label: `command:${command.name}`,
    });
    override defer = false;
    override ephemeral = ephemeralDefault;
    override options = options;

    async run(interaction: CommandInteraction) {
      const currentConfig = resolveCurrentConfig();
      const currentDiscordConfig = mergeDiscordAccountConfig(currentConfig, accountId);
      const responseEphemeral = resolveDiscordSlashCommandConfig(
        currentDiscordConfig.slashCommand,
      ).ephemeral;
      const deferred = await safeDiscordInteractionCall("interaction defer", () =>
        interaction.defer({ ephemeral: responseEphemeral }),
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
        cfg: currentConfig,
        discordConfig: currentDiscordConfig,
        accountId,
        sessionPrefix,
        // Slash commands are deferred up front, so all later responses must use
        // follow-up/edit semantics instead of the initial reply endpoint.
        preferFollowUp: true,
        threadBindings,
        responseEphemeral,
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
  expectedRoute?: Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;
  requireCoreCommandAuthorization?: boolean;
  commandAuthorizationValues?: Record<string, string>;
}): Promise<DispatchDiscordCommandInteractionResult> {
  const {
    interaction,
    prompt,
    command,
    commandArgs,
    cfg: inputConfig,
    accountId,
    sessionPrefix,
    preferFollowUp,
    threadBindings,
    responseEphemeral,
    suppressReplies,
    expectedRoute,
    requireCoreCommandAuthorization,
    commandAuthorizationValues,
  } = params;
  const cfg = getRuntimeConfigSnapshot() ?? inputConfig;
  const discordConfig = mergeDiscordAccountConfig(cfg, accountId);
  const commandName = command.nativeName ?? command.key;
  let coreCommandAuthorizationRoute:
    | {
        agentId: string;
        sessionKey: string;
        commandName: string;
        rawArguments?: string;
        values?: Readonly<Record<string, string>>;
      }
    | undefined;
  const accepted = (
    effectiveRoute?: ResolvedAgentRoute,
  ): DispatchDiscordCommandInteractionResult => ({
    accepted: true,
    ...(effectiveRoute ? { effectiveRoute } : {}),
    ...(coreCommandAuthorizationRoute
      ? { coreCommandAuthorization: coreCommandAuthorizationRoute }
      : {}),
  });
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
  const authenticatedChannelId = interaction.rawData.channel_id?.trim() ?? "";
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
    channelIdFallback: authenticatedChannelId,
  });
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const configuredDmAllowFrom =
    resolveDiscordAccountAllowFrom({
      cfg,
      accountId,
    }) ?? [];
  const commandOwnerAllowFrom = resolveDiscordCommandOwnerAllowFrom(cfg);
  const { ownerAllowList: discordOwnerAllowList, ownerAllowed: discordOwnerOk } =
    resolveDiscordOwnerAccess({
      allowFrom: configuredDmAllowFrom,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
    });
  const { ownerAllowed: commandOwnerOk } = resolveDiscordOwnerAccess({
    allowFrom: commandOwnerAllowFrom,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
    allowNameMatching,
  });
  const commandOwnerAllowAll = commandOwnerAllowFrom?.includes("*") === true;
  const senderIsCommandOwner = commandOwnerOk || commandOwnerAllowAll;
  const ownerAllowListConfigured = discordOwnerAllowList != null;
  const ownerOk = discordOwnerOk;
  const { commandsAllowFromAccess, guildInfo, channelConfig } =
    resolveDiscordNativeCommandChannelAccessContext({
      cfg,
      discordConfig,
      accountId,
      sender,
      isDirectMessage,
      isThreadChannel,
      guild: interaction.guild ?? null,
      rawChannelId,
      channelName,
      channelSlug,
      threadParentId,
      threadParentName,
      threadParentSlug,
    });
  const threadBinding = isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : undefined;
  let nativeRouteStatePromise:
    | ReturnType<typeof nativeCommandRuntime.resolveDiscordNativeInteractionRouteState>
    | undefined;
  const getNativeRouteState = () =>
    (nativeRouteStatePromise ??= nativeCommandRuntime.resolveDiscordNativeInteractionRouteState({
      cfg,
      accountId,
      guildId: interaction.guild?.id ?? undefined,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      directUserId: user.id,
      conversationId: rawChannelId || "unknown",
      parentConversationId: threadParentId,
      threadBinding,
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
  const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId }) ?? "pairing";
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      await respond("Discord DMs are disabled.");
      return { accepted: false };
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId,
      dmPolicy,
      configuredAllowFrom: configuredDmAllowFrom,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
      cfg,
      rest: interaction.client.rest,
    });
    commandAuthorized = dmAccess.senderAccess.allowed ? dmAccess.commandAccess.authorized : false;
    if (dmAccess.senderAccess.decision !== "allow") {
      await handleDiscordDmCommandDecision({
        senderAccess: dmAccess.senderAccess,
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
    commandAuthorized = await resolveDiscordGuildNativeCommandAuthorized({
      cfg,
      accountId,
      discordConfig,
      useAccessGroups,
      commandsAllowFromAccess,
      guildInfo,
      channelConfig,
      memberRoleIds,
      sender,
      allowNameMatching,
      ownerAllowListConfigured,
      ownerAllowed: ownerOk,
    });
    if (!commandAuthorized && !(await canBypassConfiguredAcpGuildGuards())) {
      await respond("You are not authorized to use this command.", { ephemeral: true });
      return { accepted: false };
    }
  }

  const pluginMatch = nativeCommandRuntime.matchPluginCommand(prompt);
  if (
    commandOwnerAllowFrom &&
    !senderIsCommandOwner &&
    !commandsAllowFromAccess.allowed &&
    commandName !== "status" &&
    !pluginMatch
  ) {
    await respond("You are not authorized to use this command.", { ephemeral: true });
    return { accepted: false };
  }

  const routeState = await getNativeRouteState();
  const bindingTarget = resolveDiscordNativeBindingTarget({
    threadBinding,
    configuredBinding: routeState.configuredBinding,
  });
  const commandRoute = resolveDiscordNativeBoundRoute({
    cfg,
    effectiveRoute: routeState.effectiveRoute,
    bindingTarget,
  });
  // Interactive controls bind authorization to the route that rendered them.
  // Fail before command policy or execution if a concurrent rebind retargeted the channel.
  if (
    expectedRoute &&
    (commandRoute.agentId !== expectedRoute.agentId ||
      commandRoute.sessionKey !== expectedRoute.sessionKey)
  ) {
    return { accepted: false, rejection: "route-mismatch" };
  }
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

  const pickerCommandContext = shouldOpenDiscordModelPickerFromCommand({
    command,
    commandArgs,
  });
  const menuArgName =
    command.argsMenu === "auto"
      ? command.args?.find((arg) => commandArgs?.values?.[arg.name] == null)?.name
      : command.argsMenu?.arg;
  const mayOpenCommandArgMenu = Boolean(
    command.args?.length &&
    command.argsMenu &&
    command.argsParsing !== "none" &&
    !(commandArgs?.raw && !commandArgs.values) &&
    menuArgName &&
    commandArgs?.values?.[menuArgName] == null,
  );
  const requiresCoreShortcutAuthorization =
    commandName === "status" ||
    requireCoreCommandAuthorization === true ||
    (!pluginMatch && (mayOpenCommandArgMenu || pickerCommandContext !== null));
  if (requiresCoreShortcutAuthorization) {
    const policySessionEntry = nativeCommandRuntime.getSessionEntry({
      agentId: commandRoute.agentId,
      sessionKey: commandRoute.sessionKey,
    });
    const authorizationCommandName = command.key;
    const authorizationRawArguments = commandArgs?.raw;
    const authorizationDenial = await authorizeNativeCoreCommand({
      commandName: authorizationCommandName,
      config: cfg,
      provider: "discord",
      accountId,
      senderId: sender.id,
      senderName: user.globalName ?? user.username,
      senderUsername: user.username,
      senderIsOwner: senderIsCommandOwner,
      isAuthorizedSender: commandAuthorized,
      roleIds: memberRoleIds,
      agentId: commandRoute.agentId,
      sessionKey: commandRoute.sessionKey,
      sessionId: policySessionEntry?.sessionId,
      conversationId: rawChannelId || undefined,
      parentConversationId: isThreadChannel ? threadParentId : undefined,
      threadId: isThreadChannel ? rawChannelId : undefined,
      rawArguments: authorizationRawArguments,
      values: commandAuthorizationValues,
    });
    if (authorizationDenial) {
      if (!suppressReplies) {
        await respond("Command blocked by authorization policy.", { ephemeral: true });
      }
      return { accepted: false, rejection: "authorization-denied" };
    }
    coreCommandAuthorizationRoute = {
      agentId: commandRoute.agentId,
      sessionKey: commandRoute.sessionKey,
      commandName: authorizationCommandName,
      ...(authorizationRawArguments !== undefined
        ? { rawArguments: authorizationRawArguments }
        : {}),
      ...(commandAuthorizationValues
        ? { values: Object.freeze({ ...commandAuthorizationValues }) }
        : {}),
    };
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
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
        route: commandRoute,
      })
    : null;
  // Native /think must not wait on provider discovery; persisted rows retain its metadata.
  const menuModelCatalog =
    command.key === "think" && menuNeedsModelContext
      ? await loadModelCatalog({ config: cfg, readOnly: true })
      : undefined;
  const menu = resolveCommandArgMenu({
    command,
    args: commandArgs,
    cfg,
    provider: menuModelContext?.provider,
    model: menuModelContext?.model,
    agentRuntime: menuModelContext?.agentRuntime,
    ...(menuModelCatalog?.length ? { catalog: menuModelCatalog } : {}),
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
      return accepted(commandRoute);
    }
    await safeDiscordInteractionCall("interaction reply", () =>
      interaction.reply({
        content: menuPayload.content,
        components: menuPayload.components,
        ephemeral: true,
      }),
    );
    return accepted(commandRoute);
  }

  let pluginContinuesAgent = false;
  let pluginContinuationAlreadyReplied = false;
  if (pluginMatch && commandName !== "status") {
    if (suppressReplies) {
      return accepted(commandRoute);
    }
    const messageThreadId = !isDirectMessage && isThreadChannel ? channelId : undefined;
    const pluginThreadParentId = !isDirectMessage && isThreadChannel ? threadParentId : undefined;
    const targetSessionEntry = nativeCommandRuntime.getSessionEntry({
      agentId: commandRoute.agentId,
      sessionKey: commandRoute.sessionKey,
    });
    const pluginReply = await nativeCommandRuntime.executePluginCommand({
      command: pluginMatch.command,
      args: pluginMatch.args,
      senderId: sender.id,
      senderName: user.globalName ?? user.username,
      senderUsername: user.username,
      memberRoleIds,
      channel: "discord",
      channelId,
      isAuthorizedSender: commandAuthorized,
      senderIsOwner: senderIsCommandOwner,
      agentId: commandRoute.agentId,
      sessionKey: commandRoute.sessionKey,
      sessionId: targetSessionEntry?.sessionId,
      sessionFile: targetSessionEntry?.sessionFile,
      authProfileId: targetSessionEntry?.authProfileOverride,
      commandBody: prompt,
      commandSource: "native",
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
      conversationId: channelId,
      parentConversationId: pluginThreadParentId,
    });
    const {
      continueAgent: shouldContinueAgent,
      suppressReply: shouldSuppressPluginReply,
      ...pluginReplyPayload
    } = pluginReply;
    const hasVisiblePluginReply = hasRenderableReplyPayload(pluginReplyPayload);
    if (shouldContinueAgent !== true) {
      if (shouldSuppressPluginReply === true) {
        return accepted(commandRoute);
      }
      if (!hasVisiblePluginReply) {
        await respond(DISCORD_EMPTY_VISIBLE_REPLY_WARNING);
        return accepted(commandRoute);
      }
      await deliverDiscordInteractionReply({
        interaction,
        payload: pluginReplyPayload,
        textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
          fallbackLimit: 2000,
        }),
        maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
        preferFollowUp,
        responseEphemeral,
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
      });
      return accepted(commandRoute);
    }

    // The final command.invoke policy and plugin handler already ran above. Keep the
    // original slash body for the model while preventing the generic dispatcher from
    // executing the same plugin command a second time.
    pluginContinuesAgent = true;
    if (shouldSuppressPluginReply !== true && hasVisiblePluginReply) {
      await deliverDiscordInteractionReply({
        interaction,
        payload: pluginReplyPayload,
        textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
          fallbackLimit: 2000,
        }),
        maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
        preferFollowUp,
        responseEphemeral,
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
      });
      pluginContinuationAlreadyReplied = true;
    }
  }

  if (pickerCommandContext) {
    await replyWithDiscordModelPickerProviders({
      interaction,
      cfg,
      command: pickerCommandContext,
      userId: user.id,
      accountId,
      threadBindings,
      route: commandRoute,
      preferFollowUp,
      safeInteractionCall: safeDiscordInteractionCall,
    });
    return accepted(commandRoute);
  }

  const interactionId = interaction.rawData.id;
  const boundSessionKey = bindingTarget?.sessionKey ?? routeState.boundSessionKey;
  const effectiveRoute = commandRoute;
  const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
    agentId: effectiveRoute.agentId,
    sessionPrefix,
    userId: user.id,
    targetSessionKey: effectiveRoute.sessionKey,
    boundSessionKey,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);
  const ctxPayload = buildDiscordNativeCommandContext({
    prompt,
    bodyForCommands: pluginContinuesAgent ? NATIVE_PLUGIN_CONTINUATION_COMMAND_BODY : undefined,
    commandArgs: commandArgs ?? {},
    agentId: effectiveRoute.agentId,
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

  const directStatusResult = await maybeDeliverDiscordDirectStatus({
    commandName,
    suppressReplies,
    resolveDirectStatusReplyForSession: nativeCommandRuntime.resolveDirectStatusReplyForSession,
    cfg,
    discordConfig,
    accountId,
    sessionKey,
    commandTargetSessionKey,
    channel: "discord",
    senderId: sender.id,
    senderIsOwner: senderIsCommandOwner,
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
    return directStatusResult.accepted
      ? accepted(directStatusResult.effectiveRoute)
      : directStatusResult;
  }

  await dispatchDiscordNativeAgentReply({
    cfg,
    discordConfig,
    accountId,
    interaction,
    ctxPayload,
    effectiveRoute,
    channelConfig,
    mediaLocalRoots,
    preferFollowUp,
    responseEphemeral,
    suppressReplies,
    alreadyReplied: pluginContinuationAlreadyReplied,
    log,
  });

  return accepted(effectiveRoute);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
