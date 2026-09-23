import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { loadPreparedModelCatalog, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
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
import type {
  PluginCommandCatalogDecision,
  PluginCommandNativeCandidate,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
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
  resolveDiscordChannelPolicyCommandAuthorizer,
  resolveDiscordOwnerAccess,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { readDiscordInteractionPolicy } from "./live-policy-interaction.js";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import { dispatchDiscordNativeAgentReply } from "./native-command-agent-reply.js";
import {
  buildDiscordCommandArgMenu,
  createDiscordCommandArgFallbackButton as createDiscordCommandArgFallbackButtonUi,
} from "./native-command-arg-ui.js";
import {
  resolveDiscordGuildNativeCommandAuthorized,
  resolveDiscordNativeAutocompleteAuthorized,
  resolveDiscordNativeCommandChannelAccessContext,
  createDiscordNativeCommandAuthority,
  resolveDiscordNativeGroupDmAccess,
  resolveDiscordNativePolicyReader,
} from "./native-command-auth.js";
import {
  shouldBypassConfiguredAcpEnsure,
  shouldBypassConfiguredAcpGuildGuards,
} from "./native-command-bypass.js";
import { buildDiscordNativeInteractionContext } from "./native-command-context.js";
import type { DispatchDiscordCommandInteractionResult } from "./native-command-dispatch.js";
import {
  createDiscordModelPickerFallbackButton as createDiscordModelPickerFallbackButtonUi,
  createDiscordModelPickerFallbackSelect as createDiscordModelPickerFallbackSelectUi,
} from "./native-command-model-picker-interaction.js";
import {
  replyWithDiscordModelPickerProviders,
  resolveDiscordNativeChoiceContext,
  shouldOpenDiscordModelPickerFromCommand,
} from "./native-command-model-picker-ui.js";
import {
  DISCORD_EMPTY_VISIBLE_REPLY_WARNING,
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
  safeDiscordInteractionCall,
  settleDiscordInteractionWithoutVisibleReply,
} from "./native-command-reply.js";
import { maybeDeliverDiscordDirectStatus } from "./native-command-status.js";
import type {
  DiscordCommandArgContext,
  DiscordModelPickerContext,
} from "./native-command-ui.types.js";
import { createNativeCommandDefinition, readDiscordCommandArgs } from "./native-command.args.js";
import {
  buildDiscordCommandOptions,
  truncateDiscordCommandDescriptionLocalizations,
  truncateDiscordCommandDescription,
} from "./native-command.options.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import type {
  DiscordBuildInboundContext,
  DiscordCommandArgs,
  DiscordConfig,
  DiscordDispatchReplyFromConfig,
} from "./native-command.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

const log = createSubsystemLogger("discord/native-command");

const NON_PLUGIN_COMMAND_DISPATCH = Object.freeze({ kind: "non-plugin" as const });

export function createDiscordNativeCommand(params: {
  readPolicy?: DiscordLivePolicyReader;
  command: NativeCommandSpec | PluginCommandNativeCandidate;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
  threadBindings: ThreadBindingManager;
  buildContext?: DiscordBuildInboundContext;
  dispatchReplyFromConfig?: DiscordDispatchReplyFromConfig;
}): Command {
  const {
    command,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    ephemeralDefault,
    threadBindings,
    buildContext,
    dispatchReplyFromConfig,
  } = params;
  const fallbackCommandDefinition = createNativeCommandDefinition(command);
  const pluginCommandCandidate = "prepareDispatch" in command ? command : undefined;
  const commandDefinition = pluginCommandCandidate
    ? fallbackCommandDefinition
    : (findCommandByNativeName(command.name, "discord", {
        includeBundledChannelFallback: false,
      }) ?? fallbackCommandDefinition);
  const argDefinitions = commandDefinition.args ?? ("args" in command ? command.args : undefined);
  const resolveCurrentConfig = () => getRuntimeConfigSnapshot() ?? cfg;
  const readPolicy = resolveDiscordNativePolicyReader(params);
  const commandOptions = buildDiscordCommandOptions({
    command: commandDefinition,
    cfg,
    resolveConfig: resolveCurrentConfig,
    authorizeChoiceContext: async (interaction) => {
      const policy = await readDiscordInteractionPolicy(readPolicy);
      if (!policy) {
        return false;
      }
      return await resolveDiscordNativeAutocompleteAuthorized({
        interaction,
        ...policy,
        isPolicyCurrent: policy.isCurrent,
        accountId,
        sessionPrefix,
        threadBindings,
        buildContext,
        skipCommandOwnerAllowFrom: pluginCommandCandidate !== undefined,
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
      const preparedPluginCommand = pluginCommandCandidate?.prepareDispatch(
        commandArgsWithRaw?.raw,
      );
      await dispatchDiscordCommandInteraction({
        readPolicy,
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
        buildContext,
        dispatchReplyFromConfig,
        pluginCommandDispatch: preparedPluginCommand ?? NON_PLUGIN_COMMAND_DISPATCH,
      });
    }
  })();
}

async function dispatchDiscordCommandInteraction(params: {
  readPolicy?: DiscordLivePolicyReader;
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
  buildContext?: DiscordBuildInboundContext;
  dispatchReplyFromConfig?: DiscordDispatchReplyFromConfig;
  pluginCommandDispatch: PluginCommandCatalogDecision;
}): Promise<DispatchDiscordCommandInteractionResult> {
  const {
    interaction,
    prompt,
    command,
    commandArgs,
    cfg: inputConfig,
    discordConfig: inputDiscordConfig,
    accountId,
    sessionPrefix,
    preferFollowUp,
    threadBindings,
    responseEphemeral,
    suppressReplies,
    buildContext,
    dispatchReplyFromConfig,
  } = params;
  const policy = await params.readPolicy?.();
  const cfg = policy?.cfg ?? getRuntimeConfigSnapshot() ?? inputConfig;
  const discordConfig = policy?.discordConfig ?? inputDiscordConfig;
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

  const useAccessGroups = true;
  const user = interaction.user;
  if (!user) {
    return { accepted: false };
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const channel = interaction.channel;
  const channelContext = await resolveDiscordNativeInteractionChannelContext({
    channel,
    client: interaction.client,
    hasGuild: Boolean(interaction.guild),
    channelIdFallback: interaction.rawData.channel_id ?? "",
  });
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
  } = channelContext;
  if (policy?.isCurrent() === false) {
    await respond("Access policy changed. Try this interaction again.", { ephemeral: true });
    return { accepted: false };
  }
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const configuredDmAllowFrom =
    resolveDiscordAccountAllowFrom({
      cfg,
      accountId,
    }) ?? [];
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
  let nativeRouteState:
    | ReturnType<typeof nativeCommandRuntime.resolveDiscordNativeInteractionRouteState>
    | undefined;
  const getNativeRouteState = () =>
    (nativeRouteState ??= nativeCommandRuntime.resolveDiscordNativeInteractionRouteState({
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
    }));
  const canBypassConfiguredAcpGuildGuards = () => {
    if (!interaction.guild || !shouldBypassConfiguredAcpGuildGuards(commandName)) {
      return false;
    }
    const routeState = getNativeRouteState();
    return (
      routeState.effectiveRoute.matchedBy === "binding.channel" ||
      routeState.boundSessionKey != null ||
      routeState.configuredBinding != null
    );
  };
  if (channelConfig?.enabled === false && !canBypassConfiguredAcpGuildGuards()) {
    await respond("This channel is disabled.");
    return { accepted: false };
  }
  if (
    interaction.guild &&
    channelConfig?.allowed === false &&
    !canBypassConfiguredAcpGuildGuards()
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
    if (!policyAuthorizer.allowed && !canBypassConfiguredAcpGuildGuards()) {
      await respond("This channel is not allowed.");
      return { accepted: false };
    }
  }
  if (policy?.isCurrent() === false) {
    await respond("Access policy changed. Try this interaction again.", { ephemeral: true });
    return { accepted: false };
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
    if (policy?.isCurrent() === false) {
      await respond("Access policy changed. Try this interaction again.", { ephemeral: true });
      return { accepted: false };
    }
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
    if (!commandAuthorized && !canBypassConfiguredAcpGuildGuards()) {
      await respond("You are not authorized to use this command.", { ephemeral: true });
      return { accepted: false };
    }
  }

  if (policy?.isCurrent() === false) {
    await respond("Access policy changed. Try this interaction again.", { ephemeral: true });
    return { accepted: false };
  }
  const routeState = getNativeRouteState();
  const effectiveRoute = routeState.effectiveRoute;
  const { ctxPayload, sessionKey, commandTargetSessionKey } =
    await buildDiscordNativeInteractionContext({
      buildContext,
      interaction,
      channelContext,
      route: effectiveRoute,
      boundSessionKey: routeState.boundSessionKey,
      sessionPrefix,
      prompt,
      commandArgs: commandArgs ?? {},
      channelConfig,
      guildInfo,
      allowNameMatching,
      commandAuthorized,
      user,
      sender,
    });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);

  if (policy?.isCurrent() === false) {
    await respond("Access policy changed. Try this interaction again.", { ephemeral: true });
    return { accepted: false };
  }
  const authority = createDiscordNativeCommandAuthority({
    cfg,
    ctx: ctxPayload,
    commandAuthorized,
    sender,
    allowNameMatching,
    isPolicyCurrent: policy?.isCurrent,
    accountId,
    guildId: interaction.guild?.id,
    commandName,
    pluginCommand: params.pluginCommandDispatch.kind === "plugin",
  });
  if (!authority.isAllowed()) {
    await respond("You are not authorized to use this command.", { ephemeral: true });
    return { accepted: false };
  }

  const bindingReadiness =
    routeState.configuredBinding && !shouldBypassConfiguredAcpEnsure(commandName)
      ? await nativeCommandRuntime.ensureConfiguredBindingRouteReady({
          cfg,
          bindingResolution: routeState.configuredBinding,
          assertActive: authority.assertActive,
        })
      : null;

  if (!authority.isAllowed()) {
    await respond("You are not authorized to use this command.", { ephemeral: true });
    return { accepted: false };
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
  const menuNeedsModelContext =
    !(commandArgs?.raw && !commandArgs.values) &&
    command.args?.some(
      (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
    );
  const menuModelContext =
    menuNeedsModelContext && bindingReadiness?.ok !== false
      ? await resolveDiscordNativeChoiceContext({
          interaction: interaction as CommandInteraction,
          cfg,
          accountId,
          threadBindings,
          route: effectiveRoute,
        })
      : null;
  // Native /think must not wait on provider discovery; persisted rows retain its metadata.
  const menuModelCatalog =
    command.key === "think" && menuNeedsModelContext
      ? await loadPreparedModelCatalog({
          config: cfg,
          ...(menuModelContext?.agentId
            ? {
                agentId: menuModelContext.agentId,
                agentDir: resolveAgentDir(cfg, menuModelContext.agentId),
              }
            : {}),
          readOnly: true,
        })
      : undefined;
  // Normal dispatch owns the unavailable-binding reply; do not offer choices it cannot apply.
  const menu =
    command.key === "verbose" && bindingReadiness?.ok === false
      ? null
      : resolveCommandArgMenu({
          command,
          args: commandArgs,
          cfg,
          session: command.key === "verbose" ? effectiveRoute : undefined,
          provider: menuModelContext?.provider,
          model: menuModelContext?.model,
          agentRuntime: menuModelContext?.agentRuntime,
          catalog: menuModelCatalog,
        });
  if (policy?.isCurrent() === false) {
    await respond("Access policy changed. Try this interaction again.", { ephemeral: true });
    return { accepted: false };
  }
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
        buildContext,
        dispatchReplyFromConfig,
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

  if (params.pluginCommandDispatch.kind === "plugin" && commandName !== "status") {
    if (suppressReplies) {
      await settleDiscordInteractionWithoutVisibleReply(interaction);
      return { accepted: true };
    }
    const messageThreadId = !isDirectMessage && isThreadChannel ? channelId : undefined;
    const pluginThreadParentId = !isDirectMessage && isThreadChannel ? threadParentId : undefined;
    const pluginCommandAgentId =
      (isThreadChannel ? threadBindings.getByThreadId(rawChannelId)?.agentId : undefined) ||
      routeState.configuredBinding?.statefulTarget.agentId ||
      effectiveRoute.agentId;
    const targetSessionEntry = nativeCommandRuntime.getSessionEntry({
      agentId: pluginCommandAgentId,
      sessionKey: effectiveRoute.sessionKey,
    });
    authority.assertActive();
    const senderIsOwner = authority.senderIsOwner();
    const pluginReply = await params.pluginCommandDispatch.execute({
      senderId: sender.id,
      channel: "discord",
      channelId,
      isAuthorizedSender: commandAuthorized,
      senderIsOwner,
      ...(senderIsOwner ? { assertOwnerCurrent: authority.assertOwnerCurrent } : {}),
      agentId: pluginCommandAgentId,
      sessionKey: effectiveRoute.sessionKey,
      authProfileId: targetSessionEntry?.authProfileOverride,
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
    if (pluginReply.suppressReply === true) {
      await settleDiscordInteractionWithoutVisibleReply(interaction);
      return { accepted: true, effectiveRoute };
    }
    if (!hasRenderableReplyPayload(pluginReply)) {
      await respond(DISCORD_EMPTY_VISIBLE_REPLY_WARNING);
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

  if (bindingReadiness && !bindingReadiness.ok) {
    const configuredBinding = routeState.configuredBinding;
    if (configuredBinding) {
      logVerbose(
        `discord native command: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${bindingReadiness.error}`,
      );
      await respond("Configured ACP binding is unavailable right now. Please try again.");
      return { accepted: false };
    }
  }

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
    senderIsOwner: authority.senderIsOwner(),
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

  const { dispatched, hiddenFinalReply } = await dispatchDiscordNativeAgentReply({
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
    dispatchReplyFromConfig,
    log,
    pluginCommandDispatch: params.pluginCommandDispatch,
  });

  return { accepted: dispatched, effectiveRoute, hiddenFinalReply };
}

export function createDiscordCommandArgFallbackButton(params: DiscordCommandArgContext): Button {
  return createDiscordCommandArgFallbackButtonUi({
    ctx: { ...params, readPolicy: resolveDiscordNativePolicyReader(params) },
    safeInteractionCall: safeDiscordInteractionCall,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
  });
}

export function createDiscordModelPickerFallbackButton(params: DiscordModelPickerContext): Button {
  return createDiscordModelPickerFallbackButtonUi({
    ctx: { ...params, readPolicy: resolveDiscordNativePolicyReader(params) },
    safeInteractionCall: safeDiscordInteractionCall,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
  });
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerContext,
): StringSelectMenu {
  return createDiscordModelPickerFallbackSelectUi({
    ctx: { ...params, readPolicy: resolveDiscordNativePolicyReader(params) },
    safeInteractionCall: safeDiscordInteractionCall,
    dispatchCommandInteraction: dispatchDiscordCommandInteraction,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
