// Discord plugin module implements native command model picker interaction behavior.
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  type ChatCommandDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { mergeDiscordAccountConfig } from "../accounts.js";
import {
  Button,
  StringSelectMenu,
  type ButtonInteraction,
  type ComponentData,
  type MessagePayload,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import { readDiscordModelPickerRecentModels } from "./model-picker-preferences.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  DISCORD_MODEL_PICKER_RUNTIME_PAGE_NEXT_VALUE,
  DISCORD_MODEL_PICKER_RUNTIME_PAGE_PREV_VALUE,
  createDiscordModelPickerInteractionBinding,
  createDiscordModelPickerModelFingerprint,
  createDiscordModelPickerProviderFingerprint,
  createDiscordModelPickerRuntimeFingerprint,
  findModelBucketId,
  findProviderBucketId,
  getDiscordModelPickerRuntimeChoices,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  type DiscordModelPickerState,
} from "./model-picker.state.js";
import {
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
} from "./model-picker.view.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import { applyDiscordModelPickerSelection } from "./native-command-model-picker-apply.js";
import { authorizeDiscordModelPickerInteraction } from "./native-command-model-picker-authorization.js";
import {
  buildDiscordModelPickerAllowedModelRefs,
  buildDiscordModelPickerNoticePayload,
  resolveDiscordModelPickerCurrentModel,
  resolveDiscordModelPickerCurrentRuntime,
  resolveDiscordModelPickerPreferenceScope,
  resolveDiscordModelPickerRoute,
  splitDiscordModelRef,
} from "./native-command-model-picker-ui.js";
import type {
  DiscordModelPickerContext,
  SafeDiscordInteractionCall,
} from "./native-command-ui.types.js";

function resolveModelPickerSelectionValue(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | null {
  const rawValues = (interaction as { values?: string[] }).values;
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    return null;
  }
  const first = rawValues[0];
  if (typeof first !== "string") {
    return null;
  }
  return first.trim() ? first : null;
}

function resolveExactModelPickerSelectionValue(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | null {
  const rawValues = (interaction as { values?: string[] }).values;
  const first = rawValues?.[0];
  return typeof first === "string" && first.length > 0 ? first : null;
}

function resolveModelPickerProviderByFingerprint(params: {
  data: ModelsProviderData;
  providerFingerprint?: string;
}): string | undefined {
  if (!params.providerFingerprint) {
    return undefined;
  }
  const matches = params.data.providers.filter(
    (provider) =>
      createDiscordModelPickerProviderFingerprint(provider) === params.providerFingerprint,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveModelPickerRuntimeByFingerprint(params: {
  data: ModelsProviderData;
  provider?: string;
  runtimeFingerprint?: string;
}): string | undefined {
  if (!params.provider || !params.runtimeFingerprint) {
    return undefined;
  }
  const choices = getDiscordModelPickerRuntimeChoices({
    data: params.data,
    provider: params.provider,
  });
  const matches = choices.filter(
    (choice) =>
      createDiscordModelPickerRuntimeFingerprint(params.provider ?? "", choice.id) ===
      params.runtimeFingerprint,
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function resolveModelPickerProvider(params: {
  parsedProvider?: string;
  currentModelRef?: string | null;
  data: ModelsProviderData;
}): string {
  return (
    params.parsedProvider ??
    splitDiscordModelRef(params.currentModelRef ?? "")?.provider ??
    params.data.resolvedDefault.provider
  );
}

function resolveSelectedBucket(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | undefined {
  const raw = resolveExactModelPickerSelectionValue(interaction);
  return raw && raw !== "all" ? raw : undefined;
}

function resolvePendingRuntime(params: {
  data: ModelsProviderData;
  provider: string;
  parsed: DiscordModelPickerState;
}): string | undefined {
  return resolveModelPickerRuntimeByFingerprint({
    data: params.data,
    provider: params.provider,
    runtimeFingerprint: params.parsed.runtimeFingerprint,
  });
}

function resolveParsedRuntimeForSubmission(params: {
  data: ModelsProviderData;
  parsed: DiscordModelPickerState;
  selectedProvider: string;
}): string | undefined {
  // The runtime fingerprint is scoped to its encoded provider. Recents can
  // submit another provider, so never reinterpret it against different choices.
  if (params.parsed.provider !== params.selectedProvider) {
    return undefined;
  }
  return resolveModelPickerRuntimeByFingerprint({
    data: params.data,
    provider: params.selectedProvider,
    runtimeFingerprint: params.parsed.runtimeFingerprint,
  });
}

function resolveSubmittedModelRef(params: {
  data: ModelsProviderData;
  parsed: DiscordModelPickerState;
}): { provider: string; model: string } | null {
  if (params.parsed.action === "reset") {
    return {
      provider: params.data.resolvedDefault.provider,
      model: params.data.resolvedDefault.model,
    };
  }
  if (params.parsed.modelFingerprint) {
    return resolveDiscordModelPickerModelRefByFingerprint(
      params.data,
      params.parsed.modelFingerprint,
    );
  }
  return null;
}

function buildDiscordModelPickerSelectionCommand(params: {
  provider: string;
  model: string;
  runtime?: string;
}): {
  command: ChatCommandDefinition;
  args: CommandArgs;
  prompt: string;
  authorizationValues: Record<string, string>;
} | null {
  const commandDefinition =
    findCommandByNativeName("model", "discord") ??
    listChatCommands().find((entry) => entry.key === "model");
  if (!commandDefinition) {
    return null;
  }
  const modelRef = `${params.provider}/${params.model}`;
  const rawArguments = params.runtime ? `${modelRef} --runtime ${params.runtime}` : modelRef;
  const commandArgs: CommandArgs = {
    values: {
      model: modelRef,
    },
    raw: rawArguments,
  };
  return {
    command: commandDefinition,
    args: commandArgs,
    prompt: buildCommandTextFromArgs(commandDefinition, commandArgs),
    authorizationValues: {
      provider: params.provider,
      model: params.model,
      ...(params.runtime ? { runtime: params.runtime } : {}),
    },
  };
}

function listDiscordModelPickerProviderModels(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
  provider: string,
): string[] {
  const modelSet = data.byProvider.get(provider);
  if (!modelSet) {
    return [];
  }
  return [...modelSet].toSorted();
}

function resolveDiscordModelPickerModelRefByFingerprint(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
  modelFingerprint: string,
): { provider: string; model: string } | null {
  const matchingRefs: Array<{ provider: string; model: string }> = [];
  for (const [provider, models] of data.byProvider) {
    for (const model of models) {
      if (createDiscordModelPickerModelFingerprint(provider, model) === modelFingerprint) {
        matchingRefs.push({ provider, model });
      }
    }
  }
  return matchingRefs.length === 1 ? (matchingRefs[0] ?? null) : null;
}

function resolveDiscordModelPickerModelIndex(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  model: string;
}): number | null {
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

function resolveDiscordModelPickerModelSelection(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  modelFingerprint?: string;
}): string | null {
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  if (params.modelFingerprint) {
    const matchingModels = models.filter(
      (model) =>
        createDiscordModelPickerModelFingerprint(params.provider, model) ===
        params.modelFingerprint,
    );
    return matchingModels.length === 1 ? (matchingModels[0] ?? null) : null;
  }
  return null;
}

function resolveDiscordModelPickerRuntimeForProvider(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  runtime?: string;
  allowResetRuntime?: boolean;
}): string | undefined {
  const runtime = normalizeOptionalString(params.runtime);
  if (!runtime) {
    return undefined;
  }
  if (runtime === "auto" || runtime === "default") {
    return params.allowResetRuntime ? runtime : undefined;
  }
  const choices = getDiscordModelPickerRuntimeChoices({
    data: params.data,
    provider: params.provider,
  });
  return choices.some((choice) => choice.id === runtime) ? runtime : undefined;
}

function resolveDiscordModelPickerSubmissionRuntime(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  parsedRuntime?: string;
  currentRuntime?: string;
}): string | undefined {
  const parsedRuntime = resolveDiscordModelPickerRuntimeForProvider({
    data: params.data,
    provider: params.provider,
    runtime: params.parsedRuntime,
    allowResetRuntime: true,
  });
  if (parsedRuntime) {
    return parsedRuntime;
  }

  const currentRuntime = normalizeOptionalString(params.currentRuntime);
  if (!currentRuntime || currentRuntime === "auto") {
    return undefined;
  }
  return (
    resolveDiscordModelPickerRuntimeForProvider({
      data: params.data,
      provider: params.provider,
      runtime: currentRuntime,
    }) ?? "auto"
  );
}

async function handleDiscordModelPickerInteraction(params: {
  interaction: ButtonInteraction | StringSelectMenuInteraction;
  data: ComponentData;
  ctx: DiscordModelPickerContext;
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
  const currentUserId = interaction.user?.id?.trim();

  let deferredUpdate = interaction.acknowledged;
  if (!deferredUpdate) {
    const deferred = await params.safeInteractionCall("model picker defer", () =>
      interaction.acknowledge(),
    );
    if (deferred === null) {
      return;
    }
    deferredUpdate = true;
  }
  const updatePicker = async (payload: MessagePayload) =>
    await params.safeInteractionCall("model picker update", () =>
      deferredUpdate ? interaction.editReply(payload) : interaction.update(payload),
    );
  const showNotice = async (message: string) =>
    await updatePicker(buildDiscordModelPickerNoticePayload(message));
  const showPrivateNotice = async (message: string) =>
    await params.safeInteractionCall("model picker follow-up", () =>
      interaction.followUp({
        ...buildDiscordModelPickerNoticePayload(message),
        ephemeral: true,
      }),
    );
  if (!currentUserId) {
    await showPrivateNotice("Sorry, that model picker interaction is no longer available.");
    return;
  }

  const cfg = getRuntimeConfigSnapshot() ?? ctx.cfg;
  const discordConfig = mergeDiscordAccountConfig(cfg, ctx.accountId);
  const route = await resolveDiscordModelPickerRoute({
    interaction,
    cfg,
    accountId: ctx.accountId,
    threadBindings: ctx.threadBindings,
  });
  const currentInteractionBinding = createDiscordModelPickerInteractionBinding({
    accountId: ctx.accountId,
    userId: currentUserId,
    route,
  });
  if (currentInteractionBinding !== parsed.interactionBinding) {
    await showPrivateNotice("Sorry, that model picker is not authorized for this session.");
    return;
  }
  const interactionAuthorization = await authorizeDiscordModelPickerInteraction({
    interaction,
    cfg,
    discordConfig,
    accountId: ctx.accountId,
    route,
    commandName: parsed.command,
  });
  if (!interactionAuthorization.allowed) {
    await showNotice(interactionAuthorization.noticeMessage);
    return;
  }
  const pickerData = await loadDiscordModelPickerData(cfg, route.agentId);
  if (parsed.providerFingerprint) {
    const resolvedProvider = resolveModelPickerProviderByFingerprint({
      data: pickerData,
      providerFingerprint: parsed.providerFingerprint,
    });
    if (!resolvedProvider) {
      await showNotice("That provider selection expired. Please choose a provider again.");
      return;
    }
    parsed.provider = resolvedProvider;
    parsed.providerFingerprint = undefined;
  }
  if (
    parsed.runtimeFingerprint &&
    !resolveModelPickerRuntimeByFingerprint({
      data: pickerData,
      provider: parsed.provider,
      runtimeFingerprint: parsed.runtimeFingerprint,
    })
  ) {
    await showNotice("That runtime selection expired. Please choose a runtime again.");
    return;
  }
  const currentModelRef = resolveDiscordModelPickerCurrentModel({
    cfg,
    route,
    data: pickerData,
  });
  const currentRuntime = resolveDiscordModelPickerCurrentRuntime({
    cfg,
    route,
  });
  const allowedModelRefs = buildDiscordModelPickerAllowedModelRefs(pickerData);
  const preferenceScope = resolveDiscordModelPickerPreferenceScope({
    interaction,
    accountId: ctx.accountId,
    userId: currentUserId,
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: preferenceScope,
    allowedModelRefs,
    limit: 5,
  });
  if (parsed.action === "recents") {
    const rendered = renderDiscordModelPickerRecentsView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      quickModels,
      currentModel: currentModelRef,
      runtimeFingerprint: parsed.runtimeFingerprint,
      provider: parsed.provider,
      page: parsed.page,
      providerPage: parsed.providerPage,
      modelBucket: parsed.modelBucket,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "back" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      page: parsed.page,
      providerBucket: parsed.providerBucket,
      currentModel: currentModelRef,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "nav" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      page: parsed.page,
      providerBucket: parsed.providerBucket,
      currentModel: currentModelRef,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "bucket" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      page: 1,
      providerBucket: resolveSelectedBucket(interaction),
      currentModel: currentModelRef,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "bucket" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider: parsed.provider,
      currentModelRef,
      data: pickerData,
    });
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      provider,
      page: 1,
      providerPage: parsed.providerPage ?? 1,
      // bucket-action customId omits providerBucket to stay under 100
      // chars; derive from the picked provider on re-render.
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, provider),
      modelBucket: resolveSelectedBucket(interaction),
      currentModel: currentModelRef,
      currentRuntime,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "nav" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider: parsed.provider,
      currentModelRef,
      data: pickerData,
    });
    const pendingModel = resolveDiscordModelPickerModelSelection({
      data: pickerData,
      provider,
      modelFingerprint: parsed.modelFingerprint,
    });
    if (parsed.modelFingerprint && !pendingModel) {
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }
    const pendingModelIndex = pendingModel
      ? resolveDiscordModelPickerModelIndex({ data: pickerData, provider, model: pendingModel })
      : undefined;
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, provider),
      modelBucket: parsed.modelBucket,
      currentModel: currentModelRef,
      currentRuntime,
      ...(pendingModel ? { pendingModel: `${provider}/${pendingModel}` } : {}),
      pendingModelIndex: pendingModelIndex ?? undefined,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "back" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider: parsed.provider,
      currentModelRef,
      data: pickerData,
    });
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      provider,
      page: parsed.page ?? 1,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, provider),
      modelBucket: parsed.modelBucket,
      currentModel: currentModelRef,
      currentRuntime,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "provider") {
    const selectedProviderFingerprint = resolveModelPickerSelectionValue(interaction);
    const selectedProvider = selectedProviderFingerprint
      ? resolveModelPickerProviderByFingerprint({
          data: pickerData,
          providerFingerprint: selectedProviderFingerprint,
        })
      : parsed.provider;
    if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
      await showNotice("Sorry, that provider isn't available anymore.");
      return;
    }
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      provider: selectedProvider,
      page: 1,
      providerPage: parsed.providerPage ?? parsed.page,
      // Provider button customId no longer carries providerBucket;
      // derive from the picked provider so the bucket select stays in
      // sync on the next render.
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, selectedProvider),
      currentModel: currentModelRef,
      currentRuntime,
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "model") {
    const selectedModelFingerprint = resolveModelPickerSelectionValue(interaction);
    const provider = parsed.provider;
    if (!provider || !selectedModelFingerprint) {
      await showNotice("Sorry, I couldn't read that model selection.");
      return;
    }
    const selectedModel = resolveDiscordModelPickerModelSelection({
      data: pickerData,
      provider,
      modelFingerprint: selectedModelFingerprint,
    });
    if (!selectedModel) {
      await showNotice("Sorry, that model isn't available anymore.");
      return;
    }
    const modelIndex = resolveDiscordModelPickerModelIndex({
      data: pickerData,
      provider,
      model: selectedModel,
    });
    if (!modelIndex) {
      await showNotice("Sorry, that model isn't available anymore.");
      return;
    }
    const modelRef = `${provider}/${selectedModel}`;
    // The model select customId omits providerBucket/modelBucket to stay
    // under Discord's 100-char limit; derive both from the durable state.
    const derivedProviderBucket =
      parsed.providerBucket ?? findProviderBucketId(pickerData, provider);
    const derivedModelBucket =
      parsed.modelBucket ?? findModelBucketId(pickerData, provider, selectedModel);
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: derivedProviderBucket,
      modelBucket: derivedModelBucket,
      currentModel: currentModelRef,
      currentRuntime,
      pendingModel: modelRef,
      pendingModelIndex: modelIndex,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "runtime") {
    const selectedRuntimeValue = resolveModelPickerSelectionValue(interaction);
    const provider = parsed.provider;
    if (!provider || !pickerData.byProvider.has(provider)) {
      await showNotice("Sorry, that provider isn't available anymore.");
      return;
    }
    const runtimePageDelta =
      selectedRuntimeValue === DISCORD_MODEL_PICKER_RUNTIME_PAGE_PREV_VALUE
        ? -1
        : selectedRuntimeValue === DISCORD_MODEL_PICKER_RUNTIME_PAGE_NEXT_VALUE
          ? 1
          : 0;
    const selectedRuntime = runtimePageDelta
      ? resolvePendingRuntime({ data: pickerData, provider, parsed })
      : resolveModelPickerRuntimeByFingerprint({
          data: pickerData,
          provider,
          runtimeFingerprint: selectedRuntimeValue ?? undefined,
        });
    if (!runtimePageDelta && !selectedRuntime) {
      await showNotice("That runtime selection expired. Please choose a runtime again.");
      return;
    }
    const selectedModel = resolveDiscordModelPickerModelSelection({
      data: pickerData,
      provider,
      modelFingerprint: parsed.modelFingerprint,
    });
    if (parsed.modelFingerprint && !selectedModel) {
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }
    const pendingModel = selectedModel ? `${provider}/${selectedModel}` : undefined;
    const pendingModelIndex = selectedModel
      ? resolveDiscordModelPickerModelIndex({ data: pickerData, provider, model: selectedModel })
      : undefined;
    // Runtime select customId carries modelBucket only when no pending
    // model is set; otherwise derive from the pending model. As a final
    // fallback, derive from the user's current durable model so the
    // browse-bucket position survives a runtime change without anything
    // pending.
    const derivedProviderBucket =
      parsed.providerBucket ?? findProviderBucketId(pickerData, provider);
    const currentModelOnly = splitDiscordModelRef(currentModelRef ?? "");
    const derivedModelBucket =
      parsed.modelBucket ??
      (selectedModel
        ? findModelBucketId(pickerData, provider, selectedModel)
        : currentModelOnly && currentModelOnly.provider === provider
          ? findModelBucketId(pickerData, provider, currentModelOnly.model)
          : undefined);
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      interactionBinding: parsed.interactionBinding,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: derivedProviderBucket,
      modelBucket: derivedModelBucket,
      currentModel: currentModelRef,
      currentRuntime,
      ...(pendingModel ? { pendingModel } : {}),
      pendingModelIndex: pendingModelIndex ?? undefined,
      ...(selectedRuntime ? { pendingRuntime: selectedRuntime } : {}),
      ...(runtimePageDelta
        ? { runtimePage: Math.max(1, (parsed.runtimePage ?? 1) + runtimePageDelta) }
        : {}),
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
    const parsedModelRef = resolveSubmittedModelRef({
      data: pickerData,
      parsed,
    });
    if (
      !parsedModelRef ||
      !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)
    ) {
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
    const selectedRuntime = resolveDiscordModelPickerSubmissionRuntime({
      data: pickerData,
      provider: parsedModelRef.provider,
      parsedRuntime: resolveParsedRuntimeForSubmission({
        data: pickerData,
        parsed,
        selectedProvider: parsedModelRef.provider,
      }),
      currentRuntime,
    });
    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      provider: parsedModelRef.provider,
      model: parsedModelRef.model,
      runtime: selectedRuntime,
    });
    if (!selectionCommand) {
      await showNotice("Sorry, /model is unavailable right now.");
      return;
    }
    const mutationAuthorization = await authorizeDiscordModelPickerInteraction({
      interaction,
      cfg,
      discordConfig,
      accountId: ctx.accountId,
      route,
      commandName: "model",
      rawArguments: selectionCommand.args.raw,
      values: selectionCommand.authorizationValues,
    });
    if (!mutationAuthorization.allowed) {
      await showNotice(mutationAuthorization.noticeMessage);
      return;
    }
    const updateResult = await showNotice(`Applying model change to ${resolvedModelRef}...`);
    if (updateResult === null) {
      return;
    }

    const applyResult = await applyDiscordModelPickerSelection({
      interaction,
      selectionCommand,
      dispatchCommandInteraction: params.dispatchCommandInteraction,
      cfg,
      discordConfig,
      accountId: ctx.accountId,
      sessionPrefix: ctx.sessionPrefix,
      threadBindings: ctx.threadBindings,
      route,
      resolvedModelRef,
      selectedProvider: parsedModelRef.provider,
      selectedModel: parsedModelRef.model,
      selectedRuntime,
      defaultProvider: pickerData.resolvedDefault.provider,
      defaultModel: pickerData.resolvedDefault.model,
      preferenceScope,
      settleMs: ctx.postApplySettleMs ?? 250,
      resolveCurrentModel: (currentRoute) =>
        resolveDiscordModelPickerCurrentModel({
          cfg,
          route: currentRoute,
          data: pickerData,
        }),
      resolveCurrentRuntime: (currentRoute) =>
        resolveDiscordModelPickerCurrentRuntime({ cfg, route: currentRoute }),
      authorizeDirectPersist: async (currentRoute, sessionBinding) =>
        await authorizeDiscordModelPickerInteraction({
          interaction,
          cfg,
          discordConfig,
          accountId: ctx.accountId,
          route: currentRoute,
          commandName: "model",
          rawArguments: selectionCommand.args.raw,
          values: selectionCommand.authorizationValues,
          sessionBinding,
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
    const displayModel = currentModelRef ?? "default";
    await showNotice(`ℹ️ Model kept as ${displayModel}.`);
  }
}

type DiscordModelPickerFallbackParams = {
  ctx: DiscordModelPickerContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
};

async function runDiscordModelPickerFallback(
  params: DiscordModelPickerFallbackParams & {
    interaction: ButtonInteraction | StringSelectMenuInteraction;
    data: ComponentData;
  },
) {
  await handleDiscordModelPickerInteraction(params);
}

class DiscordModelPickerFallbackButton extends Button {
  label = "modelpick";
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;

  constructor(private readonly params: DiscordModelPickerFallbackParams) {
    super();
  }

  override async run(interaction: ButtonInteraction, data: ComponentData) {
    await runDiscordModelPickerFallback({ ...this.params, interaction, data });
  }
}

class DiscordModelPickerFallbackSelect extends StringSelectMenu {
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
  options = [];

  constructor(private readonly params: DiscordModelPickerFallbackParams) {
    super();
  }

  override async run(interaction: StringSelectMenuInteraction, data: ComponentData) {
    await runDiscordModelPickerFallback({ ...this.params, interaction, data });
  }
}

export function createDiscordModelPickerFallbackButton(
  params: DiscordModelPickerFallbackParams,
): Button {
  return new DiscordModelPickerFallbackButton(params);
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerFallbackParams,
): StringSelectMenu {
  return new DiscordModelPickerFallbackSelect(params);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
