import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  resolveEffectiveAgentRuntime,
  type ChatCommandDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  Button,
  StringSelectMenu,
  type ButtonInteraction,
  type ComponentData,
  type MessagePayload,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import { splitDiscordModelRef } from "./model-picker-preference-primitives.js";
import { readDiscordModelPickerRecentModels } from "./model-picker-preferences.js";
import {
  getDiscordModelPickerRuntimeChoices,
  MODEL_PICKER_CHANGED_MESSAGE,
  supportsDiscordModelPickerRuntimeChoices,
} from "./model-picker.runtime.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  createDiscordModelPickerModelToken,
  createDiscordModelPickerRuntimeToken,
  findModelBucketId,
  findProviderBucketLocation,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  type DiscordModelPickerState,
} from "./model-picker.state.js";
import {
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
} from "./model-picker.view.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import { applyDiscordModelPickerSelection } from "./native-command-model-picker-apply.js";
import {
  buildDiscordModelPickerAllowedModelRefs,
  buildDiscordModelPickerNoticePayload,
  createDiscordModelPickerSessionReader,
  resolveDiscordModelPickerCurrentModel,
  resolveDiscordModelPickerCurrentRuntime,
  resolveDiscordModelPickerPreferenceScope,
  resolveDiscordModelPickerRoute,
} from "./native-command-model-picker-ui.js";
import type {
  DiscordCommandArgContext,
  SafeDiscordInteractionCall,
} from "./native-command-ui.types.js";

function resolveModelPickerSelectionValue(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | null {
  return normalizeOptionalString(interaction.values?.[0]) ?? null;
}

function resolveRuntimeToken(
  choices: ReturnType<typeof getDiscordModelPickerRuntimeChoices>,
  token: string | undefined,
): string | undefined {
  if (!token) {
    return undefined;
  }
  const matches = choices?.filter(
    (choice) => createDiscordModelPickerRuntimeToken(choice.id) === token,
  );
  return matches?.length === 1 ? matches[0]?.id : undefined;
}

function resolveSelectedBucket(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | undefined {
  const raw = resolveModelPickerSelectionValue(interaction)?.toLowerCase();
  return raw && raw !== "all" ? raw : undefined;
}

function resolveSubmittedModelRef(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  parsed: DiscordModelPickerState;
  quickModels: string[];
  requireModelToken: boolean;
}): string | null {
  if (params.parsed.action === "reset") {
    return `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  }
  if (params.parsed.modelToken) {
    return resolveDiscordModelPickerModelRefByToken(params.data, params.parsed.modelToken);
  }
  if (params.parsed.action === "quick") {
    if (params.requireModelToken) {
      return null;
    }
    const slot = params.parsed.recentSlot ?? 0;
    return slot >= 1 ? (params.quickModels[slot - 1] ?? null) : null;
  }
  if (params.parsed.view === "recents") {
    if (params.requireModelToken) {
      return null;
    }
    const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
    const dedupedRecents = params.quickModels.filter((ref) => ref !== defaultModelRef);
    const slot = params.parsed.recentSlot ?? 0;
    if (slot === 1) {
      return defaultModelRef;
    }
    return slot >= 2 ? (dedupedRecents[slot - 2] ?? null) : null;
  }

  const provider = params.parsed.provider;
  const selectedModel = resolveDiscordModelPickerModelSelection({
    data: params.data,
    provider: provider ?? "",
    modelIndex: params.parsed.modelIndex,
    modelToken: params.parsed.modelToken,
    requireModelToken: params.requireModelToken,
  });
  return provider && selectedModel ? `${provider}/${selectedModel}` : null;
}

function buildDiscordModelPickerSelectionCommand(params: {
  modelRef: string;
  runtime?: string;
}): { command: ChatCommandDefinition; args: CommandArgs; prompt: string } | null {
  const commandDefinition =
    findCommandByNativeName("model", "discord") ??
    listChatCommands().find((entry) => entry.key === "model");
  if (!commandDefinition) {
    return null;
  }
  const commandArgs: CommandArgs = {
    values: {
      model: params.modelRef,
    },
    raw: params.runtime ? `${params.modelRef} --runtime ${params.runtime}` : params.modelRef,
  };
  return {
    command: commandDefinition,
    args: commandArgs,
    prompt: buildCommandTextFromArgs(commandDefinition, commandArgs),
  };
}

function listDiscordModelPickerProviderModels(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
  provider: string,
): string[] {
  // Legacy index callbacks depend on JavaScript's original UTF-16 code-unit ordering.
  return [...(data.byProvider.get(provider) ?? [])].toSorted();
}

function resolveDiscordModelPickerModelRefByToken(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
  modelToken: string,
): string | null {
  const matchingRefs: string[] = [];
  for (const [provider, models] of data.byProvider) {
    for (const model of models) {
      if (createDiscordModelPickerModelToken(provider, model) === modelToken) {
        matchingRefs.push(`${provider}/${model}`);
      }
    }
  }
  return matchingRefs.length === 1 ? (matchingRefs[0] ?? null) : null;
}

function resolveDiscordModelPickerModelSelection(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  modelIndex?: number;
  modelToken?: string;
  requireModelToken?: boolean;
}): string | null {
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (params.modelToken) {
    const matchingModels = models.filter(
      (model) => createDiscordModelPickerModelToken(params.provider, model) === params.modelToken,
    );
    return matchingModels.length === 1 ? (matchingModels[0] ?? null) : null;
  }
  if (params.requireModelToken || !params.modelIndex || params.modelIndex < 1) {
    return null;
  }
  return models[params.modelIndex - 1] ?? null;
}

async function handleDiscordModelPickerInteraction(params: {
  interaction: ButtonInteraction | StringSelectMenuInteraction;
  data: ComponentData;
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}) {
  const { interaction, data, ctx } = params;
  const parsed = parseDiscordModelPickerData(data);
  if (!parsed) {
    await params.safeInteractionCall("model picker update", () =>
      interaction.update(
        buildDiscordModelPickerNoticePayload(
          "Sorry, that model picker interaction is no longer available.",
        ),
      ),
    );
    return;
  }

  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await params.safeInteractionCall("model picker ack", () => interaction.acknowledge());
    return;
  }

  if (!interaction.acknowledged) {
    const deferred = await params.safeInteractionCall("model picker defer", () =>
      interaction.acknowledge(),
    );
    if (deferred === null) {
      return;
    }
  }

  const cfg = getRuntimeConfigSnapshot() ?? ctx.cfg;
  const requireModelToken = cfg !== ctx.cfg;
  const route = await resolveDiscordModelPickerRoute({
    interaction,
    cfg,
    accountId: ctx.accountId,
    threadBindings: ctx.threadBindings,
  });
  const sessionEntry = createDiscordModelPickerSessionReader({ cfg, route }, "latest")();
  const pickerData = await loadDiscordModelPickerData(cfg, route.agentId, { sessionEntry });
  const tokenModel = parsed.modelToken
    ? resolveDiscordModelPickerModelRefByToken(pickerData, parsed.modelToken)
    : null;
  const parsedProvider = parsed.provider ?? splitDiscordModelRef(tokenModel ?? "")?.provider;
  const modelContext = { cfg, route, data: pickerData };
  const currentModelRef = resolveDiscordModelPickerCurrentModel(modelContext);
  const currentModel = splitDiscordModelRef(currentModelRef);
  const browseProvider =
    parsedProvider ?? currentModel?.provider ?? pickerData.resolvedDefault.provider;
  const resolvePendingRuntime = (provider: string) =>
    parsed.runtime ??
    resolveRuntimeToken(
      getDiscordModelPickerRuntimeChoices(pickerData, provider),
      parsed.runtimeToken,
    );
  const currentRuntime = resolveDiscordModelPickerCurrentRuntime(modelContext);
  const allowedModelRefs = buildDiscordModelPickerAllowedModelRefs(pickerData);
  const preferenceScope = resolveDiscordModelPickerPreferenceScope({
    interaction,
    accountId: ctx.accountId,
    userId: parsed.userId,
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: preferenceScope,
    allowedModelRefs,
    limit: 5,
  });
  const updatePicker = async (payload: MessagePayload) =>
    await params.safeInteractionCall("model picker update", () => interaction.editReply(payload));
  const showNotice = async (message: string) =>
    await updatePicker(buildDiscordModelPickerNoticePayload(message));
  const renderContext = {
    command: parsed.command,
    userId: parsed.userId,
    data: pickerData,
    currentModel: currentModelRef,
  };
  const updateModelsView = async (
    provider: string,
    state: Omit<
      Parameters<typeof renderDiscordModelPickerModelsView>[0],
      keyof typeof renderContext | "provider" | "currentRuntime" | "quickModels"
    > = {},
  ) => {
    // Provider bucket is recoverable from durable catalog state, so compact
    // custom IDs do not need to carry it through every interaction.
    const rendered = renderDiscordModelPickerModelsView({
      ...renderContext,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket:
        parsed.providerBucket ?? findProviderBucketLocation(pickerData, provider)?.bucket,
      currentRuntime,
      quickModels,
      ...state,
    });
    return await updatePicker(rendered);
  };

  if (parsed.action !== "cancel" && pickerData.isCurrent?.() === false) {
    await showNotice("That model picker expired. Reopen /model to try again.");
    return;
  }
  if (
    (parsed.runtimeIndex !== undefined && parsed.action !== "cancel") ||
    (parsed.runtimeToken &&
      !["submit", "reset", "quick", "cancel"].includes(parsed.action) &&
      parsedProvider &&
      !resolvePendingRuntime(parsedProvider))
  ) {
    await showNotice("That runtime selection expired. Reopen /model and choose a runtime again.");
    return;
  }

  if (parsed.action === "recents") {
    const rendered = renderDiscordModelPickerRecentsView({
      ...renderContext,
      quickModels,
      runtime: parsed.runtime,
      runtimeToken: parsed.runtimeToken,
      provider: parsed.provider,
      page: parsed.page,
      providerPage: parsed.providerPage,
      modelBucket: parsed.modelBucket,
    });
    await updatePicker(rendered);
    return;
  }

  if (
    parsed.view === "providers" &&
    (parsed.action === "back" || parsed.action === "nav" || parsed.action === "bucket")
  ) {
    const selectingBucket = parsed.action === "bucket";
    const rendered = renderDiscordModelPickerProvidersView({
      ...renderContext,
      page: selectingBucket ? 1 : parsed.page,
      providerBucket: selectingBucket ? resolveSelectedBucket(interaction) : parsed.providerBucket,
    });
    await updatePicker(rendered);
    return;
  }

  if (parsed.view === "models" && (parsed.action === "bucket" || parsed.action === "back")) {
    const selectingBucket = parsed.action === "bucket";
    await updateModelsView(browseProvider, {
      page: selectingBucket ? 1 : parsed.page,
      modelBucket: selectingBucket ? resolveSelectedBucket(interaction) : parsed.modelBucket,
      pendingRuntime: resolvePendingRuntime(browseProvider),
    });
    return;
  }

  if (parsed.action === "provider") {
    const selectedProvider = resolveModelPickerSelectionValue(interaction) ?? parsed.provider;
    if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
      await showNotice(MODEL_PICKER_CHANGED_MESSAGE);
      return;
    }
    await updateModelsView(selectedProvider, {
      page: 1,
      providerPage: parsed.providerPage ?? parsed.page,
    });
    return;
  }

  if (
    parsed.action === "model" ||
    parsed.action === "pick" ||
    parsed.action === "runtime" ||
    (parsed.action === "nav" && parsed.view === "models")
  ) {
    const selectingModel = parsed.action === "model" || parsed.action === "pick";
    const selectingRuntime = parsed.action === "runtime";
    const provider = parsed.action === "nav" ? browseProvider : (parsedProvider ?? "");
    if (
      parsed.action !== "nav" &&
      (!provider || (selectingRuntime && !pickerData.byProvider.has(provider)))
    ) {
      await showNotice(MODEL_PICKER_CHANGED_MESSAGE);
      return;
    }
    const selectedValue = selectingModel ? resolveModelPickerSelectionValue(interaction) : null;
    // Legacy menus carry raw model IDs; new menus and pending selections carry tokens.
    const selectedModel =
      parsed.action === "model"
        ? selectedValue
        : resolveDiscordModelPickerModelSelection({
            data: pickerData,
            provider,
            modelIndex: selectingModel ? undefined : parsed.modelIndex,
            modelToken: selectingModel ? (selectedValue ?? undefined) : parsed.modelToken,
            requireModelToken: selectingModel || requireModelToken,
          });
    const selectedIndex = selectedModel
      ? listDiscordModelPickerProviderModels(pickerData, provider).indexOf(selectedModel)
      : -1;
    const modelIndex = selectedIndex < 0 ? undefined : selectedIndex + 1;
    if (
      (selectingModel && !modelIndex) ||
      (!selectingModel && (parsed.modelIndex || parsed.modelToken) && !selectedModel)
    ) {
      await showNotice(MODEL_PICKER_CHANGED_MESSAGE);
      return;
    }

    let modelBucket = parsed.modelBucket;
    let pendingRuntime: string | undefined;
    if (selectingRuntime) {
      const selectedRuntime = resolveModelPickerSelectionValue(interaction) ?? parsed.runtime;
      const runtimeModel =
        selectedModel ?? (currentModel?.provider === provider ? currentModel.model : undefined);
      const choices = getDiscordModelPickerRuntimeChoices(pickerData, provider, runtimeModel);
      if (!selectedRuntime || !choices?.some((choice) => choice.id === selectedRuntime)) {
        await showNotice("That runtime is not available for this model. Choose a runtime again.");
        return;
      }
      pendingRuntime = selectedRuntime;
      // Pending IDs omit the bucket; recover browse position from the pending or current model.
      modelBucket ??= runtimeModel
        ? findModelBucketId(pickerData, provider, runtimeModel)
        : undefined;
    } else {
      pendingRuntime = resolvePendingRuntime(provider);
      if (selectingModel && selectedModel) {
        modelBucket ??= findModelBucketId(pickerData, provider, selectedModel);
      }
    }
    await updateModelsView(provider, {
      modelBucket,
      ...(selectedModel ? { pendingModel: `${provider}/${selectedModel}` } : {}),
      pendingModelIndex: modelIndex,
      pendingRuntime,
    });
    return;
  }

  if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
    const modelRef = resolveSubmittedModelRef({
      data: pickerData,
      parsed,
      quickModels,
      requireModelToken,
    });
    const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
    if (
      !parsedModelRef ||
      !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)
    ) {
      await showNotice(MODEL_PICKER_CHANGED_MESSAGE);
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
    const choices = getDiscordModelPickerRuntimeChoices(
      pickerData,
      parsedModelRef.provider,
      parsedModelRef.model,
    );
    const modelOnlyHost = !supportsDiscordModelPickerRuntimeChoices();
    const supportsModelOnlySelection = () => {
      const currentEntry = createDiscordModelPickerSessionReader({ cfg, route }, "latest")();
      const override = currentEntry?.agentRuntimeOverride?.trim();
      // The old command owner cannot validate native pins against a different model.
      // Preserve those pins; model-only compatibility never invents a runtime choice.
      if (override && !["auto", "default", "openclaw"].includes(override)) {
        return false;
      }
      const model = pickerData.modelCatalog?.find(
        (entry) => entry.provider === parsedModelRef.provider && entry.id === parsedModelRef.model,
      );
      return (
        resolveEffectiveAgentRuntime({
          cfg,
          provider: parsedModelRef.provider,
          modelId: parsedModelRef.model,
          modelApi: model?.api,
          modelBaseUrl: model?.baseUrl,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          sessionEntry: currentEntry,
        }) === "openclaw"
      );
    };
    const legacyRuntimeNotice =
      "This OpenClaw version supports model-only selection here. Update OpenClaw to change runtimes in the picker.";
    if (modelOnlyHost && (parsed.runtime || parsed.runtimeToken || !supportsModelOnlySelection())) {
      await showNotice(legacyRuntimeNotice);
      return;
    }
    if (!modelOnlyHost && choices === undefined) {
      await showNotice("Runtime availability is not confirmed. Reopen /model to try again.");
      return;
    }
    const selectedRuntime =
      normalizeOptionalString(parsed.runtime) ?? resolveRuntimeToken(choices, parsed.runtimeToken);
    if (
      choices?.length === 0 ||
      (parsed.runtimeToken && selectedRuntime === undefined) ||
      (selectedRuntime &&
        selectedRuntime !== "auto" &&
        selectedRuntime !== "default" &&
        !choices?.some((choice) => choice.id === selectedRuntime))
    ) {
      await showNotice(
        "That runtime is not available for this model. Reopen /model and choose again.",
      );
      return;
    }
    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      modelRef: resolvedModelRef,
      runtime: selectedRuntime,
    });
    if (!selectionCommand) {
      await showNotice("Sorry, /model is unavailable right now.");
      return;
    }

    const updateResult = await showNotice(`Applying model change to ${resolvedModelRef}...`);
    if (updateResult === null) {
      return;
    }

    if (pickerData.isCurrent?.() === false) {
      await showNotice("That model picker expired. Reopen /model to try again.");
      return;
    }
    if (modelOnlyHost && !supportsModelOnlySelection()) {
      await showNotice(legacyRuntimeNotice);
      return;
    }
    const applyResult = await applyDiscordModelPickerSelection({
      ...ctx,
      interaction,
      selectionCommand,
      dispatchCommandInteraction: params.dispatchCommandInteraction,
      cfg,
      route,
      resolvedModelRef,
      selectedRuntime,
      preferenceScope,
      settleMs: ctx.postApplySettleMs ?? 250,
      resolveCurrentModel: (currentRoute) =>
        resolveDiscordModelPickerCurrentModel({
          ...modelContext,
          route: currentRoute,
        }),
      resolveCurrentRuntime: (currentRoute) =>
        resolveDiscordModelPickerCurrentRuntime({
          cfg,
          route: currentRoute,
        }),
    });

    await params.safeInteractionCall("model picker follow-up", () =>
      interaction.followUp({
        ...buildDiscordModelPickerNoticePayload(applyResult.noticeMessage),
        ephemeral: true,
      }),
    );
    return;
  }

  if (parsed.action === "cancel") {
    await showNotice(`ℹ️ Model kept as ${currentModelRef}.`);
  }
}

type DiscordModelPickerFallbackParams = {
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
};

export function createDiscordModelPickerFallbackButton(
  params: DiscordModelPickerFallbackParams,
): Button {
  return new (class extends Button {
    label = "modelpick";
    customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;

    override async run(interaction: ButtonInteraction, data: ComponentData) {
      await handleDiscordModelPickerInteraction({ ...params, interaction, data });
    }
  })();
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerFallbackParams,
): StringSelectMenu {
  return new (class extends StringSelectMenu {
    customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
    options = [];

    override async run(interaction: StringSelectMenuInteraction, data: ComponentData) {
      await handleDiscordModelPickerInteraction({ ...params, interaction, data });
    }
  })();
}
