import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { loadPreparedModelCatalog, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import { ensureConfiguredBindingRouteReady } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { buildPairingReply } from "openclaw/plugin-sdk/conversation-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  parseCommandArgs,
  resolveCommandArgMenu,
  serializeCommandArgs,
  type CommandArgs,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import type { PluginCommandNativeCandidate } from "openclaw/plugin-sdk/plugin-command-runtime";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntryAsync } from "openclaw/plugin-sdk/session-store-runtime";
import { recordDeliveredCommandExchange } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveDiscordAccountDmPolicy } from "../accounts.js";
import { Command, type CommandInteraction, type CommandOptions } from "../internal/discord.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { readDiscordInteractionPolicy } from "./live-policy-interaction.js";
import { dispatchDiscordNativeAgentReply } from "./native-command-agent-reply.js";
import {
  buildDiscordCommandArgMenu,
  createDiscordCommandArgFallbackButton as createDiscordCommandArgFallbackButtonUi,
} from "./native-command-arg-ui.js";
import {
  resolveDiscordGuildNativeCommandAuthorized,
  resolveDiscordNativeAutocompleteAuthorized,
  resolveDiscordNativeCommandAccessContext,
  createDiscordNativeCommandAuthority,
  resolveDiscordNativeGroupDmAccess,
  resolveDiscordNativePolicyReader,
} from "./native-command-auth.js";
import {
  shouldBypassConfiguredAcpEnsure,
  shouldBypassConfiguredAcpGuildGuards,
} from "./native-command-bypass.js";
import { buildDiscordNativeInteractionContext } from "./native-command-context.js";
import type {
  DispatchDiscordCommandInteractionParams,
  DispatchDiscordCommandInteractionResult,
} from "./native-command-dispatch.js";
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
  resolveDiscordInteractionReplyOptions,
  safeDiscordInteractionCall,
  settleDiscordInteractionWithoutVisibleReply,
} from "./native-command-reply.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import { maybeDeliverDiscordDirectStatus } from "./native-command-status.js";
import type { DiscordCommandArgContext } from "./native-command-ui.types.js";
import { createNativeCommandDefinition, readDiscordCommandArgs } from "./native-command.args.js";
import {
  buildDiscordCommandOptions,
  truncateDiscordCommandDescriptionLocalizations,
  truncateDiscordCommandDescription,
} from "./native-command.options.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

const log = createSubsystemLogger("discord/native-command");

const NON_PLUGIN_COMMAND_DISPATCH = Object.freeze({ kind: "non-plugin" as const });

export function createDiscordNativeCommand(
  params: DiscordCommandArgContext & {
    command: NativeCommandSpec | PluginCommandNativeCandidate;
    ephemeralDefault: boolean;
  },
): Command {
  const { command, ephemeralDefault, ...ctx } = params;
  const { cfg, accountId, threadBindings } = ctx;
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
        sessionPrefix: ctx.sessionPrefix,
        threadBindings,
        buildContext: ctx.buildContext,
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
          } satisfies CommandArgs)
        : undefined;
      const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
      const preparedPluginCommand = pluginCommandCandidate?.prepareDispatch(
        commandArgsWithRaw?.raw,
      );
      await dispatchDiscordCommandInteraction({
        ...ctx,
        readPolicy,
        interaction,
        prompt,
        command: commandDefinition,
        commandArgs: commandArgsWithRaw,
        // Slash commands are deferred up front, so all later responses must use
        // follow-up/edit semantics instead of the initial reply endpoint.
        preferFollowUp: true,
        responseEphemeral: ephemeralDefault,
        pluginCommandDispatch: preparedPluginCommand ?? NON_PLUGIN_COMMAND_DISPATCH,
      });
    }
  })();
}

async function dispatchDiscordCommandInteraction(
  params: DispatchDiscordCommandInteractionParams,
): Promise<DispatchDiscordCommandInteractionResult> {
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
    const delivered = await safeDiscordInteractionCall("interaction reply", async () => {
      await interaction[preferFollowUp ? "followUp" : "reply"](payload);
    });
    return delivered !== null;
  };
  const reject = async (content: string, ephemeral?: boolean) => {
    await respond(content, { ephemeral });
    return { accepted: false };
  };

  const user = interaction.user;
  if (!user) {
    return { accepted: false };
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const channelContext = await resolveDiscordNativeInteractionChannelContext(interaction, "");
  const {
    isDirectMessage,
    isGroupDm,
    isThreadChannel,
    channelName,
    channelSlug,
    rawChannelId,
    threadParentId,
  } = channelContext;
  if (policy?.isCurrent() === false) {
    return reject("Access policy changed. Try this interaction again.", true);
  }
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.slice()
    : [];
  const channelAccess = resolveDiscordNativeCommandAccessContext({
    cfg,
    accountId,
    discordConfig,
    sender,
    ...channelContext,
    guild: interaction.guild ?? null,
  });
  const { guildInfo, channelConfig } = channelAccess;
  let nativeRouteState: ReturnType<typeof resolveDiscordNativeInteractionRouteState> | undefined;
  const getNativeRouteState = () =>
    (nativeRouteState ??= resolveDiscordNativeInteractionRouteState({
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
  if (channelAccess.channelDenial && !canBypassConfiguredAcpGuildGuards()) {
    return reject(
      channelAccess.channelDenial === "disabled"
        ? "This channel is disabled."
        : "This channel is not allowed.",
    );
  }
  if (policy?.isCurrent() === false) {
    return reject("Access policy changed. Try this interaction again.", true);
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId }) ?? "pairing";
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      return reject("Discord DMs are disabled.");
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId,
      dmPolicy,
      configuredAllowFrom: channelAccess.configuredDmAllowFrom,
      sender,
      allowNameMatching: channelAccess.allowNameMatching,
      cfg,
      rest: interaction.client.rest,
    });
    if (policy?.isCurrent() === false) {
      return reject("Access policy changed. Try this interaction again.", true);
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
    return reject(
      groupDmAccess.reason === "disabled"
        ? "Discord group DMs are disabled."
        : "This group DM is not allowed.",
    );
  }
  if (!isDirectMessage) {
    commandAuthorized = await resolveDiscordGuildNativeCommandAuthorized({
      ...channelAccess,
      memberRoleIds,
      sender,
      ownerAllowListConfigured: channelAccess.ownerAllowList != null,
    });
    if (!commandAuthorized && !canBypassConfiguredAcpGuildGuards()) {
      return reject("You are not authorized to use this command.", true);
    }
  }

  if (policy?.isCurrent() === false) {
    return reject("Access policy changed. Try this interaction again.", true);
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
      allowNameMatching: channelAccess.allowNameMatching,
      commandAuthorized,
      user,
      sender,
    });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);

  if (policy?.isCurrent() === false) {
    return reject("Access policy changed. Try this interaction again.", true);
  }
  const authority = await createDiscordNativeCommandAuthority({
    cfg,
    ctx: ctxPayload,
    commandAuthorized,
    sender,
    allowNameMatching: channelAccess.allowNameMatching,
    isPolicyCurrent: policy?.isCurrent,
    accountId,
    guildId: interaction.guild?.id,
    commandName,
    pluginCommand: params.pluginCommandDispatch.kind === "plugin",
  });
  if (!authority.isAllowed()) {
    return reject("You are not authorized to use this command.", true);
  }

  const bindingReadiness =
    routeState.configuredBinding && !shouldBypassConfiguredAcpEnsure(commandName)
      ? await ensureConfiguredBindingRouteReady({
          cfg,
          bindingResolution: routeState.configuredBinding,
          assertActive: authority.assertActive,
        })
      : null;

  if (!authority.isAllowed()) {
    return reject("You are not authorized to use this command.", true);
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
          interaction,
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
    return reject("Access policy changed. Try this interaction again.", true);
  }
  if (menu) {
    const menuPayload = buildDiscordCommandArgMenu({
      command,
      menu,
      userId: interaction.user?.id ?? "",
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
    const delivered = await safeDiscordInteractionCall(
      preferFollowUp ? "interaction follow-up" : "interaction reply",
      () =>
        interaction[preferFollowUp ? "followUp" : "reply"]({
          content: menuPayload.content,
          components: menuPayload.components,
          ephemeral: true,
        }),
    );
    if (delivered !== null) {
      await recordDeliveredCommandExchange({
        config: cfg,
        agentId: effectiveRoute.agentId,
        sessionKey: commandTargetSessionKey?.trim() || effectiveRoute.sessionKey,
        commandText: prompt,
        commandId: `discord:${accountId}:${channelId}:${interaction.id}`,
        replyId: "argument-menu",
        replyText: `${menuPayload.content}\n${menu.choices.map((choice) => choice.label).join(", ")}`,
      });
    }
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
    const targetSessionEntry = await getSessionEntryAsync({
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
    const hasReply = hasRenderableReplyPayload(pluginReply);
    const delivered = hasReply
      ? await deliverDiscordInteractionReply({
          interaction,
          payload: pluginReply,
          ...resolveDiscordInteractionReplyOptions({ cfg, discordConfig, accountId }),
          preferFollowUp,
          responseEphemeral,
        })
      : await respond(DISCORD_EMPTY_VISIBLE_REPLY_WARNING);
    const replyText = hasReply ? pluginReply.text : DISCORD_EMPTY_VISIBLE_REPLY_WARNING;
    if (delivered && replyText) {
      await recordDeliveredCommandExchange({
        config: cfg,
        agentId: pluginCommandAgentId,
        sessionKey: effectiveRoute.sessionKey,
        expectedSessionId: targetSessionEntry?.sessionId,
        commandText: prompt,
        commandId: `discord:${accountId}:${channelId}:${interaction.id}`,
        replyId: "plugin-reply",
        replyText,
      });
    }
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
      return reject("Configured ACP binding is unavailable right now. Please try again.");
    }
  }

  const directStatusResult = await maybeDeliverDiscordDirectStatus({
    commandName,
    suppressReplies,
    resolveDirectStatusReplyForSession,
    cfg,
    discordConfig,
    accountId,
    sessionKey,
    commandTargetSessionKey,
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

function bindDiscordCommandControl<T>(
  createControl: (params: Parameters<typeof createDiscordCommandArgFallbackButtonUi>[0]) => T,
): (params: DiscordCommandArgContext) => T {
  return (params) =>
    createControl({
      ctx: { ...params, readPolicy: resolveDiscordNativePolicyReader(params) },
      safeInteractionCall: safeDiscordInteractionCall,
      dispatchCommandInteraction: dispatchDiscordCommandInteraction,
    });
}

export const createDiscordCommandArgFallbackButton = bindDiscordCommandControl(
  createDiscordCommandArgFallbackButtonUi,
);
export const createDiscordModelPickerFallbackButton = bindDiscordCommandControl(
  createDiscordModelPickerFallbackButtonUi,
);
export const createDiscordModelPickerFallbackSelect = bindDiscordCommandControl(
  createDiscordModelPickerFallbackSelectUi,
);
