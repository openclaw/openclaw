import {
  Button,
  ChannelType,
  Command,
  Container,
  Row,
  StringSelectMenu,
  TextDisplay
} from "@buape/carbon";
import { ApplicationCommandOptionType, ButtonStyle } from "discord-api-types/v10";
import {
  ensureConfiguredAcpRouteReady,
  resolveConfiguredAcpRoute
} from "../../../../src/acp/persistent-bindings.route.js";
import { resolveHumanDelayConfig } from "../../../../src/agents/identity.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../../../src/auto-reply/chunk.js";
import { resolveCommandAuthorization } from "../../../../src/auto-reply/command-auth.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  serializeCommandArgs
} from "../../../../src/auto-reply/commands-registry.js";
import { resolveStoredModelOverride } from "../../../../src/auto-reply/reply/model-selection.js";
import { dispatchReplyWithDispatcher } from "../../../../src/auto-reply/reply/provider-dispatcher.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../../../src/channels/command-gating.js";
import { resolveNativeCommandSessionTargets } from "../../../../src/channels/native-command-session-targets.js";
import { createReplyPrefixOptions } from "../../../../src/channels/reply-prefix.js";
import { isDangerousNameMatchingEnabled } from "../../../../src/config/dangerous-name-matching.js";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../../src/config/runtime-group-policy.js";
import { loadSessionStore, resolveStorePath } from "../../../../src/config/sessions.js";
import { logVerbose } from "../../../../src/globals.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { getAgentScopedMediaLocalRoots } from "../../../../src/media/local-roots.js";
import { buildPairingReply } from "../../../../src/pairing/pairing-messages.js";
import { executePluginCommand, matchPluginCommand } from "../../../../src/plugins/commands.js";
import { chunkItems } from "../../../../src/utils/chunk-items.js";
import { withTimeout } from "../../../../src/utils/with-timeout.js";
import { loadWebMedia } from "../../../whatsapp/src/media.js";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import {
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel
} from "./model-picker-preferences.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload
} from "./model-picker.js";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";
import {
  resolveDiscordBoundConversationRoute,
  resolveDiscordEffectiveRoute
} from "./route-resolution.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";
const log = createSubsystemLogger("discord/native-command");
function resolveDiscordNativeCommandAllowlistAccess(params) {
  const commandsAllowFrom = params.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return { configured: false, allowed: false };
  }
  const configured = Array.isArray(commandsAllowFrom.discord) || Array.isArray(commandsAllowFrom["*"]);
  if (!configured) {
    return { configured: false, allowed: false };
  }
  const from = params.chatType === "direct" ? `discord:${params.sender.id}` : `discord:${params.chatType}:${params.conversationId ?? "unknown"}`;
  const auth = resolveCommandAuthorization({
    ctx: {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      AccountId: params.accountId ?? void 0,
      ChatType: params.chatType,
      From: from,
      SenderId: params.sender.id,
      SenderUsername: params.sender.name,
      SenderTag: params.sender.tag
    },
    cfg: params.cfg,
    // We only want explicit commands.allowFrom authorization here.
    commandAuthorized: false
  });
  return { configured: true, allowed: auth.isAuthorizedSender };
}
function buildDiscordCommandOptions(params) {
  const { command, cfg } = params;
  const args = command.args;
  if (!args || args.length === 0) {
    return void 0;
  }
  return args.map((arg) => {
    const required = arg.required ?? false;
    if (arg.type === "number") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Number,
        required
      };
    }
    if (arg.type === "boolean") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Boolean,
        required
      };
    }
    const resolvedChoices = resolveCommandArgChoices({ command, arg, cfg });
    const shouldAutocomplete = arg.preferAutocomplete === true || resolvedChoices.length > 0 && (typeof arg.choices === "function" || resolvedChoices.length > 25);
    const autocomplete = shouldAutocomplete ? async (interaction) => {
      const focused = interaction.options.getFocused();
      const focusValue = typeof focused?.value === "string" ? focused.value.trim().toLowerCase() : "";
      const choices2 = resolveCommandArgChoices({ command, arg, cfg });
      const filtered = focusValue ? choices2.filter((choice) => choice.label.toLowerCase().includes(focusValue)) : choices2;
      await interaction.respond(
        filtered.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.value }))
      );
    } : void 0;
    const choices = resolvedChoices.length > 0 && !autocomplete ? resolvedChoices.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.value })) : void 0;
    return {
      name: arg.name,
      description: arg.description,
      type: ApplicationCommandOptionType.String,
      required,
      choices,
      autocomplete
    };
  });
}
function readDiscordCommandArgs(interaction, definitions) {
  if (!definitions || definitions.length === 0) {
    return void 0;
  }
  const values = {};
  for (const definition of definitions) {
    let value;
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
  return Object.keys(values).length > 0 ? { values } : void 0;
}
const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";
function createCommandArgsWithValue(params) {
  const values = { [params.argName]: params.value };
  return { values };
}
function encodeDiscordCommandArgValue(value) {
  return encodeURIComponent(value);
}
function decodeDiscordCommandArgValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function isDiscordUnknownInteraction(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error;
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
function hasRenderableReplyPayload(payload) {
  if ((payload.text ?? "").trim()) {
    return true;
  }
  if ((payload.mediaUrl ?? "").trim()) {
    return true;
  }
  if (payload.mediaUrls?.some((entry) => entry.trim())) {
    return true;
  }
  return false;
}
async function safeDiscordInteractionCall(label, fn) {
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
function buildDiscordCommandArgCustomId(params) {
  return [
    `${DISCORD_COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeDiscordCommandArgValue(params.command)}`,
    `arg=${encodeDiscordCommandArgValue(params.arg)}`,
    `value=${encodeDiscordCommandArgValue(params.value)}`,
    `user=${encodeDiscordCommandArgValue(params.userId)}`
  ].join(";");
}
function parseDiscordCommandArgData(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawCommand = coerce(data.command);
  const rawArg = coerce(data.arg);
  const rawValue = coerce(data.value);
  const rawUser = coerce(data.user);
  if (!rawCommand || !rawArg || !rawValue || !rawUser) {
    return null;
  }
  return {
    command: decodeDiscordCommandArgValue(rawCommand),
    arg: decodeDiscordCommandArgValue(rawArg),
    value: decodeDiscordCommandArgValue(rawValue),
    userId: decodeDiscordCommandArgValue(rawUser)
  };
}
function resolveDiscordModelPickerCommandContext(command) {
  const normalized = (command.nativeName ?? command.key).trim().toLowerCase();
  if (normalized === "model" || normalized === "models") {
    return normalized;
  }
  return null;
}
function resolveCommandArgStringValue(args, key) {
  const value = args?.values?.[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}
function shouldOpenDiscordModelPickerFromCommand(params) {
  const context = resolveDiscordModelPickerCommandContext(params.command);
  if (!context) {
    return null;
  }
  const serializedArgs = serializeCommandArgs(params.command, params.commandArgs)?.trim() ?? "";
  if (context === "model") {
    const modelValue = resolveCommandArgStringValue(params.commandArgs, "model");
    return !modelValue && !serializedArgs ? context : null;
  }
  return serializedArgs ? null : context;
}
function buildDiscordModelPickerCurrentModel(defaultProvider, defaultModel) {
  return `${defaultProvider}/${defaultModel}`;
}
function buildDiscordModelPickerAllowedModelRefs(data) {
  const out = /* @__PURE__ */ new Set();
  for (const provider of data.providers) {
    const models = data.byProvider.get(provider);
    if (!models) {
      continue;
    }
    for (const model of models) {
      out.add(`${provider}/${model}`);
    }
  }
  return out;
}
function resolveDiscordModelPickerPreferenceScope(params) {
  return {
    accountId: params.accountId,
    guildId: params.interaction.guild?.id ?? void 0,
    userId: params.userId
  };
}
function buildDiscordModelPickerNoticePayload(message) {
  return {
    components: [new Container([new TextDisplay(message)])]
  };
}
async function resolveDiscordModelPickerRoute(params) {
  const { interaction, cfg, accountId } = params;
  const channel = interaction.channel;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel = channelType === ChannelType.PublicThread || channelType === ChannelType.PrivateThread || channelType === ChannelType.AnnouncementThread;
  const rawChannelId = channel?.id ?? "unknown";
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => String(roleId)) : [];
  let threadParentId;
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: "name" in channel ? channel.name : void 0,
        parentId: "parentId" in channel ? channel.parentId ?? void 0 : void 0,
        parent: void 0
      },
      channelInfo
    });
    threadParentId = parentInfo.id;
  }
  const threadBinding = isThreadChannel ? params.threadBindings.getByThreadId(rawChannelId) : void 0;
  return resolveDiscordBoundConversationRoute({
    cfg,
    accountId,
    guildId: interaction.guild?.id ?? void 0,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    directUserId: interaction.user?.id ?? rawChannelId,
    conversationId: rawChannelId,
    parentConversationId: threadParentId,
    boundSessionKey: threadBinding?.targetSessionKey
  });
}
function resolveDiscordModelPickerCurrentModel(params) {
  const fallback = buildDiscordModelPickerCurrentModel(
    params.data.resolvedDefault.provider,
    params.data.resolvedDefault.model
  );
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId
    });
    const sessionStore = loadSessionStore(storePath, { skipCache: true });
    const sessionEntry = sessionStore[params.route.sessionKey];
    const override = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey: params.route.sessionKey
    });
    if (!override?.model) {
      return fallback;
    }
    const provider = (override.provider || params.data.resolvedDefault.provider).trim();
    if (!provider) {
      return fallback;
    }
    return `${provider}/${override.model}`;
  } catch {
    return fallback;
  }
}
async function replyWithDiscordModelPickerProviders(params) {
  const route = await resolveDiscordModelPickerRoute({
    interaction: params.interaction,
    cfg: params.cfg,
    accountId: params.accountId,
    threadBindings: params.threadBindings
  });
  const data = await loadDiscordModelPickerData(params.cfg, route.agentId);
  const currentModel = resolveDiscordModelPickerCurrentModel({
    cfg: params.cfg,
    route,
    data
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: resolveDiscordModelPickerPreferenceScope({
      interaction: params.interaction,
      accountId: params.accountId,
      userId: params.userId
    }),
    allowedModelRefs: buildDiscordModelPickerAllowedModelRefs(data),
    limit: 5
  });
  const rendered = renderDiscordModelPickerModelsView({
    command: params.command,
    userId: params.userId,
    data,
    provider: splitDiscordModelRef(currentModel ?? "")?.provider ?? data.resolvedDefault.provider,
    page: 1,
    providerPage: 1,
    currentModel,
    quickModels
  });
  const payload = {
    ...toDiscordModelPickerMessagePayload(rendered),
    ephemeral: true
  };
  await safeDiscordInteractionCall("model picker reply", async () => {
    if (params.preferFollowUp) {
      await params.interaction.followUp(payload);
      return;
    }
    await params.interaction.reply(payload);
  });
}
function resolveModelPickerSelectionValue(interaction) {
  const rawValues = interaction.values;
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    return null;
  }
  const first = rawValues[0];
  if (typeof first !== "string") {
    return null;
  }
  const trimmed = first.trim();
  return trimmed || null;
}
function buildDiscordModelPickerSelectionCommand(params) {
  const commandDefinition = findCommandByNativeName("model", "discord") ?? listChatCommands().find((entry) => entry.key === "model");
  if (!commandDefinition) {
    return null;
  }
  const commandArgs = {
    values: {
      model: params.modelRef
    },
    raw: params.modelRef
  };
  return {
    command: commandDefinition,
    args: commandArgs,
    prompt: buildCommandTextFromArgs(commandDefinition, commandArgs)
  };
}
function listDiscordModelPickerProviderModels(data, provider) {
  const modelSet = data.byProvider.get(provider);
  if (!modelSet) {
    return [];
  }
  return [...modelSet].toSorted();
}
function resolveDiscordModelPickerModelIndex(params) {
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  const index = models.indexOf(params.model);
  if (index < 0) {
    return null;
  }
  return index + 1;
}
function resolveDiscordModelPickerModelByIndex(params) {
  if (!params.modelIndex || params.modelIndex < 1) {
    return null;
  }
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  return models[params.modelIndex - 1] ?? null;
}
function splitDiscordModelRef(modelRef) {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}
async function handleDiscordModelPickerInteraction(interaction, data, ctx) {
  const parsed = parseDiscordModelPickerData(data);
  if (!parsed) {
    await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(
        buildDiscordModelPickerNoticePayload(
          "Sorry, that model picker interaction is no longer available."
        )
      )
    );
    return;
  }
  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await safeDiscordInteractionCall("model picker ack", () => interaction.acknowledge());
    return;
  }
  const route = await resolveDiscordModelPickerRoute({
    interaction,
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    threadBindings: ctx.threadBindings
  });
  const pickerData = await loadDiscordModelPickerData(ctx.cfg, route.agentId);
  const currentModelRef = resolveDiscordModelPickerCurrentModel({
    cfg: ctx.cfg,
    route,
    data: pickerData
  });
  const allowedModelRefs = buildDiscordModelPickerAllowedModelRefs(pickerData);
  const preferenceScope = resolveDiscordModelPickerPreferenceScope({
    interaction,
    accountId: ctx.accountId,
    userId: parsed.userId
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: preferenceScope,
    allowedModelRefs,
    limit: 5
  });
  if (parsed.action === "recents") {
    const rendered = renderDiscordModelPickerRecentsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      quickModels,
      currentModel: currentModelRef,
      provider: parsed.provider,
      page: parsed.page,
      providerPage: parsed.providerPage
    });
    await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(toDiscordModelPickerMessagePayload(rendered))
    );
    return;
  }
  if (parsed.action === "back" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      page: parsed.page,
      currentModel: currentModelRef
    });
    await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(toDiscordModelPickerMessagePayload(rendered))
    );
    return;
  }
  if (parsed.action === "back" && parsed.view === "models") {
    const provider = parsed.provider ?? splitDiscordModelRef(currentModelRef ?? "")?.provider ?? pickerData.resolvedDefault.provider;
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page ?? 1,
      providerPage: parsed.providerPage ?? 1,
      currentModel: currentModelRef,
      quickModels
    });
    await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(toDiscordModelPickerMessagePayload(rendered))
    );
    return;
  }
  if (parsed.action === "provider") {
    const selectedProvider = resolveModelPickerSelectionValue(interaction) ?? parsed.provider;
    if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
      await safeDiscordInteractionCall(
        "model picker update",
        () => interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, that provider isn't available anymore.")
        )
      );
      return;
    }
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider: selectedProvider,
      page: 1,
      providerPage: parsed.providerPage ?? parsed.page,
      currentModel: currentModelRef,
      quickModels
    });
    await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(toDiscordModelPickerMessagePayload(rendered))
    );
    return;
  }
  if (parsed.action === "model") {
    const selectedModel = resolveModelPickerSelectionValue(interaction);
    const provider = parsed.provider;
    if (!provider || !selectedModel) {
      await safeDiscordInteractionCall(
        "model picker update",
        () => interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, I couldn't read that model selection.")
        )
      );
      return;
    }
    const modelIndex = resolveDiscordModelPickerModelIndex({
      data: pickerData,
      provider,
      model: selectedModel
    });
    if (!modelIndex) {
      await safeDiscordInteractionCall(
        "model picker update",
        () => interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, that model isn't available anymore.")
        )
      );
      return;
    }
    const modelRef = `${provider}/${selectedModel}`;
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      currentModel: currentModelRef,
      pendingModel: modelRef,
      pendingModelIndex: modelIndex,
      quickModels
    });
    await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(toDiscordModelPickerMessagePayload(rendered))
    );
    return;
  }
  if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
    let modelRef = null;
    if (parsed.action === "reset") {
      modelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
    } else if (parsed.action === "quick") {
      const slot = parsed.recentSlot ?? 0;
      modelRef = slot >= 1 ? quickModels[slot - 1] ?? null : null;
    } else if (parsed.view === "recents") {
      const defaultModelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
      const dedupedRecents = quickModels.filter((ref) => ref !== defaultModelRef);
      const slot = parsed.recentSlot ?? 0;
      if (slot === 1) {
        modelRef = defaultModelRef;
      } else if (slot >= 2) {
        modelRef = dedupedRecents[slot - 2] ?? null;
      }
    } else {
      const provider = parsed.provider;
      const selectedModel = resolveDiscordModelPickerModelByIndex({
        data: pickerData,
        provider: provider ?? "",
        modelIndex: parsed.modelIndex
      });
      modelRef = provider && selectedModel ? `${provider}/${selectedModel}` : null;
    }
    const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
    if (!parsedModelRef || !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)) {
      await safeDiscordInteractionCall(
        "model picker update",
        () => interaction.update(
          buildDiscordModelPickerNoticePayload(
            "That selection expired. Please choose a model again."
          )
        )
      );
      return;
    }
    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      modelRef: resolvedModelRef
    });
    if (!selectionCommand) {
      await safeDiscordInteractionCall(
        "model picker update",
        () => interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, /model is unavailable right now.")
        )
      );
      return;
    }
    const updateResult = await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(
        buildDiscordModelPickerNoticePayload(`Applying model change to ${resolvedModelRef}...`)
      )
    );
    if (updateResult === null) {
      return;
    }
    try {
      await withTimeout(
        dispatchDiscordCommandInteraction({
          interaction,
          prompt: selectionCommand.prompt,
          command: selectionCommand.command,
          commandArgs: selectionCommand.args,
          cfg: ctx.cfg,
          discordConfig: ctx.discordConfig,
          accountId: ctx.accountId,
          sessionPrefix: ctx.sessionPrefix,
          preferFollowUp: true,
          threadBindings: ctx.threadBindings,
          suppressReplies: true
        }),
        12e3
      );
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        await safeDiscordInteractionCall(
          "model picker follow-up",
          () => interaction.followUp({
            ...buildDiscordModelPickerNoticePayload(
              `\u23F3 Model change to ${resolvedModelRef} is still processing. Check /status in a few seconds.`
            ),
            ephemeral: true
          })
        );
        return;
      }
      await safeDiscordInteractionCall(
        "model picker follow-up",
        () => interaction.followUp({
          ...buildDiscordModelPickerNoticePayload(
            `\u274C Failed to apply ${resolvedModelRef}. Try /model ${resolvedModelRef} directly.`
          ),
          ephemeral: true
        })
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const effectiveModelRef = resolveDiscordModelPickerCurrentModel({
      cfg: ctx.cfg,
      route,
      data: pickerData
    });
    const persisted = effectiveModelRef === resolvedModelRef;
    if (!persisted) {
      logVerbose(
        `discord: model picker override mismatch \u2014 expected ${resolvedModelRef} but read ${effectiveModelRef} from session key ${route.sessionKey}`
      );
    }
    if (persisted) {
      await recordDiscordModelPickerRecentModel({
        scope: preferenceScope,
        modelRef: resolvedModelRef,
        limit: 5
      }).catch(() => void 0);
    }
    await safeDiscordInteractionCall(
      "model picker follow-up",
      () => interaction.followUp({
        ...buildDiscordModelPickerNoticePayload(
          persisted ? `\u2705 Model set to ${resolvedModelRef}.` : `\u26A0\uFE0F Tried to set ${resolvedModelRef}, but current model is ${effectiveModelRef}.`
        ),
        ephemeral: true
      })
    );
    return;
  }
  if (parsed.action === "cancel") {
    const displayModel = currentModelRef ?? "default";
    await safeDiscordInteractionCall(
      "model picker update",
      () => interaction.update(buildDiscordModelPickerNoticePayload(`\u2139\uFE0F Model kept as ${displayModel}.`))
    );
    return;
  }
}
async function handleDiscordCommandArgInteraction(interaction, data, ctx) {
  const parsed = parseDiscordCommandArgData(data);
  if (!parsed) {
    await safeDiscordInteractionCall(
      "command arg update",
      () => interaction.update({
        content: "Sorry, that selection is no longer available.",
        components: []
      })
    );
    return;
  }
  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await safeDiscordInteractionCall("command arg ack", () => interaction.acknowledge());
    return;
  }
  const commandDefinition = findCommandByNativeName(parsed.command, "discord") ?? listChatCommands().find((entry) => entry.key === parsed.command);
  if (!commandDefinition) {
    await safeDiscordInteractionCall(
      "command arg update",
      () => interaction.update({
        content: "Sorry, that command is no longer available.",
        components: []
      })
    );
    return;
  }
  const argUpdateResult = await safeDiscordInteractionCall(
    "command arg update",
    () => interaction.update({
      content: `\u2705 Selected ${parsed.value}.`,
      components: []
    })
  );
  if (argUpdateResult === null) {
    return;
  }
  const commandArgs = createCommandArgsWithValue({
    argName: parsed.arg,
    value: parsed.value
  });
  const commandArgsWithRaw = {
    ...commandArgs,
    raw: serializeCommandArgs(commandDefinition, commandArgs)
  };
  const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
  await dispatchDiscordCommandInteraction({
    interaction,
    prompt,
    command: commandDefinition,
    commandArgs: commandArgsWithRaw,
    cfg: ctx.cfg,
    discordConfig: ctx.discordConfig,
    accountId: ctx.accountId,
    sessionPrefix: ctx.sessionPrefix,
    preferFollowUp: true,
    threadBindings: ctx.threadBindings
  });
}
class DiscordCommandArgButton extends Button {
  constructor(params) {
    super();
    this.style = ButtonStyle.Secondary;
    this.label = params.label;
    this.customId = params.customId;
    this.cfg = params.cfg;
    this.discordConfig = params.discordConfig;
    this.accountId = params.accountId;
    this.sessionPrefix = params.sessionPrefix;
    this.threadBindings = params.threadBindings;
  }
  async run(interaction, data) {
    await handleDiscordCommandArgInteraction(interaction, data, {
      cfg: this.cfg,
      discordConfig: this.discordConfig,
      accountId: this.accountId,
      sessionPrefix: this.sessionPrefix,
      threadBindings: this.threadBindings
    });
  }
}
class DiscordCommandArgFallbackButton extends Button {
  constructor(ctx) {
    super();
    this.label = "cmdarg";
    this.customId = "cmdarg:seed=1";
    this.ctx = ctx;
  }
  async run(interaction, data) {
    await handleDiscordCommandArgInteraction(interaction, data, this.ctx);
  }
}
function createDiscordCommandArgFallbackButton(params) {
  return new DiscordCommandArgFallbackButton(params);
}
class DiscordModelPickerFallbackButton extends Button {
  constructor(ctx) {
    super();
    this.label = DISCORD_MODEL_PICKER_CUSTOM_ID_KEY;
    this.customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;
    this.ctx = ctx;
  }
  async run(interaction, data) {
    await handleDiscordModelPickerInteraction(interaction, data, this.ctx);
  }
}
class DiscordModelPickerFallbackSelect extends StringSelectMenu {
  constructor(ctx) {
    super();
    this.customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
    this.options = [];
    this.ctx = ctx;
  }
  async run(interaction, data) {
    await handleDiscordModelPickerInteraction(interaction, data, this.ctx);
  }
}
function createDiscordModelPickerFallbackButton(params) {
  return new DiscordModelPickerFallbackButton(params);
}
function createDiscordModelPickerFallbackSelect(params) {
  return new DiscordModelPickerFallbackSelect(params);
}
function buildDiscordCommandArgMenu(params) {
  const { command, menu, interaction } = params;
  const commandLabel = command.nativeName ?? command.key;
  const userId = interaction.user?.id ?? "";
  const rows = chunkItems(menu.choices, 4).map((choices) => {
    const buttons = choices.map(
      (choice) => new DiscordCommandArgButton({
        label: choice.label,
        customId: buildDiscordCommandArgCustomId({
          command: commandLabel,
          arg: menu.arg.name,
          value: choice.value,
          userId
        }),
        cfg: params.cfg,
        discordConfig: params.discordConfig,
        accountId: params.accountId,
        sessionPrefix: params.sessionPrefix,
        threadBindings: params.threadBindings
      })
    );
    return new Row(buttons);
  });
  const content = menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
  return { content, components: rows };
}
function createDiscordNativeCommand(params) {
  const {
    command,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    ephemeralDefault,
    threadBindings
  } = params;
  const commandDefinition = findCommandByNativeName(command.name, "discord") ?? {
    key: command.name,
    nativeName: command.name,
    description: command.description,
    textAliases: [],
    acceptsArgs: command.acceptsArgs,
    args: command.args,
    argsParsing: "none",
    scope: "native"
  };
  const argDefinitions = commandDefinition.args ?? command.args;
  const commandOptions = buildDiscordCommandOptions({
    command: commandDefinition,
    cfg
  });
  const options = commandOptions ? commandOptions : command.acceptsArgs ? [
    {
      name: "input",
      description: "Command input",
      type: ApplicationCommandOptionType.String,
      required: false
    }
  ] : void 0;
  return new class extends Command {
    constructor() {
      super(...arguments);
      this.name = command.name;
      this.description = command.description;
      this.defer = true;
      this.ephemeral = ephemeralDefault;
      this.options = options;
    }
    async run(interaction) {
      const commandArgs = argDefinitions?.length ? readDiscordCommandArgs(interaction, argDefinitions) : command.acceptsArgs ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "") : void 0;
      const commandArgsWithRaw = commandArgs ? {
        ...commandArgs,
        raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw
      } : void 0;
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
        threadBindings
      });
    }
  }();
}
async function dispatchDiscordCommandInteraction(params) {
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
    suppressReplies
  } = params;
  const respond = async (content, options) => {
    const payload = {
      content,
      ...options?.ephemeral !== void 0 ? { ephemeral: options.ephemeral } : {}
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
  const isThreadChannel = channelType === ChannelType.PublicThread || channelType === ChannelType.PrivateThread || channelType === ChannelType.AnnouncementThread;
  const channelName = channel && "name" in channel ? channel.name : void 0;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const rawChannelId = channel?.id ?? "";
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => String(roleId)) : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag
    },
    allowNameMatching
  });
  const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
    cfg,
    accountId,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag
    },
    chatType: isDirectMessage ? "direct" : isThreadChannel ? "thread" : interaction.guild ? "channel" : "group",
    conversationId: rawChannelId || void 0
  });
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? void 0,
    guildId: interaction.guild?.id ?? void 0,
    guildEntries: discordConfig?.guilds
  });
  let threadParentId;
  let threadParentName;
  let threadParentSlug = "";
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: channelName,
        parentId: "parentId" in channel ? channel.parentId ?? void 0 : void 0,
        parent: void 0
      },
      channelInfo
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }
  const channelConfig = interaction.guild ? resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: rawChannelId,
    channelName,
    channelSlug,
    parentId: threadParentId,
    parentName: threadParentName,
    parentSlug: threadParentSlug,
    scope: isThreadChannel ? "thread" : "channel"
  }) : null;
  if (channelConfig?.enabled === false) {
    await respond("This channel is disabled.");
    return;
  }
  if (interaction.guild && channelConfig?.allowed === false) {
    await respond("This channel is not allowed.");
    return;
  }
  if (useAccessGroups && interaction.guild) {
    const channelAllowlistConfigured = Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
    const channelAllowed = channelConfig?.allowed !== false;
    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.discord !== void 0,
      groupPolicy: discordConfig?.groupPolicy,
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy
    });
    const allowByPolicy = isDiscordGroupAllowedByPolicy({
      groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed
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
        tag: sender.tag
      },
      allowNameMatching,
      useAccessGroups
    });
    commandAuthorized = dmAccess.commandAuthorized;
    if (dmAccess.decision !== "allow") {
      await handleDiscordDmCommandDecision({
        dmAccess,
        accountId,
        sender: {
          id: user.id,
          tag: sender.tag,
          name: sender.name
        },
        onPairingCreated: async (code) => {
          await respond(
            buildPairingReply({
              channel: "discord",
              idLine: `Your Discord user id: ${user.id}`,
              code
            }),
            { ephemeral: true }
          );
        },
        onUnauthorized: async () => {
          await respond("You are not authorized to use this command.", { ephemeral: true });
        }
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
      allowNameMatching
    });
    const authorizers = useAccessGroups ? [
      {
        configured: commandsAllowFromAccess.configured,
        allowed: commandsAllowFromAccess.allowed
      },
      { configured: ownerAllowList != null, allowed: ownerOk },
      { configured: hasAccessRestrictions, allowed: memberAllowed }
    ] : [
      {
        configured: commandsAllowFromAccess.configured,
        allowed: commandsAllowFromAccess.allowed
      },
      { configured: hasAccessRestrictions, allowed: memberAllowed }
    ];
    commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers,
      modeWhenAccessGroupsOff: "configured"
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
    cfg
  });
  if (menu) {
    const menuPayload = buildDiscordCommandArgMenu({
      command,
      menu,
      interaction,
      cfg,
      discordConfig,
      accountId,
      sessionPrefix,
      threadBindings
    });
    if (preferFollowUp) {
      await safeDiscordInteractionCall(
        "interaction follow-up",
        () => interaction.followUp({
          content: menuPayload.content,
          components: menuPayload.components,
          ephemeral: true
        })
      );
      return;
    }
    await safeDiscordInteractionCall(
      "interaction reply",
      () => interaction.reply({
        content: menuPayload.content,
        components: menuPayload.components,
        ephemeral: true
      })
    );
    return;
  }
  const pluginMatch = matchPluginCommand(prompt);
  if (pluginMatch) {
    if (suppressReplies) {
      return;
    }
    const channelId2 = rawChannelId || "unknown";
    const pluginReply = await executePluginCommand({
      command: pluginMatch.command,
      args: pluginMatch.args,
      senderId: sender.id,
      channel: "discord",
      channelId: channelId2,
      isAuthorizedSender: commandAuthorized,
      commandBody: prompt,
      config: cfg,
      from: isDirectMessage ? `discord:${user.id}` : isGroupDm ? `discord:group:${channelId2}` : `discord:channel:${channelId2}`,
      to: `slash:${user.id}`,
      accountId
    });
    if (!hasRenderableReplyPayload(pluginReply)) {
      await respond("Done.");
      return;
    }
    await deliverDiscordInteractionReply({
      interaction,
      payload: pluginReply,
      textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
        fallbackLimit: 2e3
      }),
      maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
      preferFollowUp,
      chunkMode: resolveChunkMode(cfg, "discord", accountId)
    });
    return;
  }
  const pickerCommandContext = shouldOpenDiscordModelPickerFromCommand({
    command,
    commandArgs
  });
  if (pickerCommandContext) {
    await replyWithDiscordModelPickerProviders({
      interaction,
      cfg,
      command: pickerCommandContext,
      userId: user.id,
      accountId,
      threadBindings,
      preferFollowUp
    });
    return;
  }
  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
  const interactionId = interaction.rawData.id;
  const route = resolveDiscordBoundConversationRoute({
    cfg,
    accountId,
    guildId: interaction.guild?.id ?? void 0,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    directUserId: user.id,
    conversationId: channelId,
    parentConversationId: threadParentId
    // Configured ACP routes apply after raw route resolution, so do not pass
    // bound/configured overrides here.
  });
  const threadBinding = isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : void 0;
  const configuredRoute = threadBinding == null ? resolveConfiguredAcpRoute({
    cfg,
    route,
    channel: "discord",
    accountId,
    conversationId: channelId,
    parentConversationId: threadParentId
  }) : null;
  const configuredBinding = configuredRoute?.configuredBinding ?? null;
  if (configuredBinding) {
    const ensured = await ensureConfiguredAcpRouteReady({
      cfg,
      configuredBinding
    });
    if (!ensured.ok) {
      logVerbose(
        `discord native command: configured ACP binding unavailable for channel ${configuredBinding.spec.conversationId}: ${ensured.error}`
      );
      await respond("Configured ACP binding is unavailable right now. Please try again.");
      return;
    }
  }
  const configuredBoundSessionKey = configuredRoute?.boundSessionKey?.trim() || void 0;
  const boundSessionKey = threadBinding?.targetSessionKey?.trim() || configuredBoundSessionKey;
  const effectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: configuredBinding ? "binding.channel" : void 0
  });
  const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
    agentId: effectiveRoute.agentId,
    sessionPrefix,
    userId: user.id,
    targetSessionKey: effectiveRoute.sessionKey,
    boundSessionKey
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
    channelTopic: channel && "topic" in channel ? channel.topic ?? void 0 : void 0,
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
      globalName: user.globalName
    },
    sender: { id: sender.id, name: sender.name, tag: sender.tag }
  });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: effectiveRoute.agentId,
    channel: "discord",
    accountId: effectiveRoute.accountId
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
              fallbackLimit: 2e3
            }),
            maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({ cfg, discordConfig, accountId }),
            preferFollowUp: preferFollowUp || didReply,
            chunkMode: resolveChunkMode(cfg, "discord", accountId)
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
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        log.error(`discord slash ${info.kind} reply failed: ${message}`);
      }
    },
    replyOptions: {
      skillFilter: channelConfig?.skills,
      disableBlockStreaming: typeof discordConfig?.blockStreaming === "boolean" ? !discordConfig.blockStreaming : void 0,
      onModelSelected
    }
  });
  if (!suppressReplies && !didReply && dispatchResult.counts.final === 0 && dispatchResult.counts.block === 0 && dispatchResult.counts.tool === 0) {
    await safeDiscordInteractionCall("interaction empty fallback", async () => {
      const payload = {
        content: "\u2705 Done.",
        ephemeral: true
      };
      if (preferFollowUp) {
        await interaction.followUp(payload);
        return;
      }
      await interaction.reply(payload);
    });
  }
}
async function deliverDiscordInteractionReply(params) {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
  const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const text = payload.text ?? "";
  let hasReplied = false;
  const sendMessage = async (content, files) => {
    const payload2 = files && files.length > 0 ? {
      content,
      files: files.map((file) => {
        if (file.data instanceof Blob) {
          return { name: file.name, data: file.data };
        }
        const arrayBuffer = Uint8Array.from(file.data).buffer;
        return { name: file.name, data: new Blob([arrayBuffer]) };
      })
    } : { content };
    await safeDiscordInteractionCall("interaction send", async () => {
      if (!preferFollowUp && !hasReplied) {
        await interaction.reply(payload2);
        hasReplied = true;
        return;
      }
      await interaction.followUp(payload2);
      hasReplied = true;
    });
  };
  if (mediaList.length > 0) {
    const media = await Promise.all(
      mediaList.map(async (url) => {
        const loaded = await loadWebMedia(url, {
          localRoots: params.mediaLocalRoots
        });
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer
        };
      })
    );
    const chunks2 = chunkDiscordTextWithMode(text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
      chunkMode
    });
    if (!chunks2.length && text) {
      chunks2.push(text);
    }
    const caption = chunks2[0] ?? "";
    await sendMessage(caption, media);
    for (const chunk of chunks2.slice(1)) {
      if (!chunk.trim()) {
        continue;
      }
      await interaction.followUp({ content: chunk });
    }
    return;
  }
  if (!text.trim()) {
    return;
  }
  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: textLimit,
    maxLines: maxLinesPerMessage,
    chunkMode
  });
  if (!chunks.length && text) {
    chunks.push(text);
  }
  for (const chunk of chunks) {
    if (!chunk.trim()) {
      continue;
    }
    await sendMessage(chunk);
  }
}
export {
  createDiscordCommandArgFallbackButton,
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  createDiscordNativeCommand
};
