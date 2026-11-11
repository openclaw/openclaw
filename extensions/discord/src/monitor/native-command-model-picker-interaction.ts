import { ComponentType } from "discord-api-types/v10";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  getModelsRuntimeChoices,
  MODEL_PICKER_CHANGED_MESSAGE,
} from "openclaw/plugin-sdk/models-provider-runtime";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { recordDeliveredCommandExchange } from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  BaseMessageInteractiveComponent,
  BaseComponentInteraction,
  ComponentData,
  MessagePayload,
} from "../internal/discord.js";
import { splitDiscordModelRef } from "./model-picker-preference-primitives.js";
import {
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel,
} from "./model-picker-preferences.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  createDiscordModelPickerModelToken,
  createDiscordModelPickerRuntimeToken,
  findProviderBucketLocation,
  getDiscordModelPickerRecentModelRefs,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  resolveDiscordModelPickerPageForModel,
} from "./model-picker.state.js";
import {
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
} from "./model-picker.view.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import {
  buildDiscordModelPickerAllowedModelRefs,
  buildDiscordModelPickerNoticePayload,
  createDiscordModelPickerSessionReader,
  resolveDiscordModelPickerCurrentModel,
  resolveDiscordModelPickerCurrentRuntime,
  resolveDiscordModelPickerPreferenceScope,
  resolveDiscordModelPickerRoute,
} from "./native-command-model-picker-ui.js";
import { formatDiscordCommandComponents } from "./native-command-reply.js";
import type {
  DiscordCommandArgContext,
  SafeDiscordInteractionCall,
} from "./native-command-ui.types.js";

function resolveModelPickerSelectionValue(interaction: BaseComponentInteraction): string | null {
  return normalizeOptionalString(interaction.values?.[0]) ?? null;
}

function resolveRuntimeToken(
  choices: ReturnType<typeof getModelsRuntimeChoices>,
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

function resolveSelectedBucket(interaction: BaseComponentInteraction): string | undefined {
  const raw = resolveModelPickerSelectionValue(interaction)?.toLowerCase();
  return raw && raw !== "all" ? raw : undefined;
}

function listDiscordModelPickerProviderModels(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
  provider: string,
): string[] {
  // Legacy index callbacks depend on JavaScript's original UTF-16 code-unit ordering.
  return [...(data.byProvider.get(provider) ?? [])].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
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

async function handleDiscordModelPickerInteraction(
  params: DiscordModelPickerFallbackParams & {
    interaction: BaseComponentInteraction;
    data: ComponentData;
  },
) {
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
  const sessionEntry = await createDiscordModelPickerSessionReader({ cfg, route }, "latest")();
  const pickerData = await loadDiscordModelPickerData(cfg, route.agentId, { sessionEntry });
  const tokenModel = parsed.modelToken
    ? resolveDiscordModelPickerModelRefByToken(pickerData, parsed.modelToken)
    : null;
  const parsedProvider = parsed.provider ?? splitDiscordModelRef(tokenModel ?? "")?.provider;
  const modelContext = { cfg, route, data: pickerData, sessionEntry };
  const currentModelRef = await resolveDiscordModelPickerCurrentModel(modelContext);
  const currentModel = splitDiscordModelRef(currentModelRef);
  const browseProvider =
    parsedProvider ?? currentModel?.provider ?? pickerData.resolvedDefault.provider;
  const resolvePendingRuntime = (provider: string) =>
    parsed.runtime ??
    resolveRuntimeToken(getModelsRuntimeChoices(pickerData, provider), parsed.runtimeToken);
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
  });
  const recordReply = async (commandText: string, replyText: string, replyId: string) =>
    await recordDeliveredCommandExchange({
      config: cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      expectedSessionId: sessionEntry?.sessionId,
      commandText,
      commandId: `discord:${ctx.accountId}:${route.sessionKey}:${interaction.id}`,
      replyId,
      replyText,
    });
  const updatePicker = async (payload: MessagePayload, capture = true) => {
    const delivered = await params.safeInteractionCall("model picker update", () =>
      interaction.editReply(payload),
    );
    if (delivered !== null && capture) {
      await recordReply(
        `/${parsed.command}`,
        typeof payload === "string"
          ? payload
          : [payload.content, formatDiscordCommandComponents(payload.components ?? [])]
              .filter(Boolean)
              .join("\n"),
        "picker-update",
      );
    }
    return delivered;
  };
  const showNotice = async (message: string, capture = true) =>
    await updatePicker(buildDiscordModelPickerNoticePayload(message), capture);
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
      const choices = getModelsRuntimeChoices(pickerData, provider, runtimeModel);
      if (!selectedRuntime || !choices?.some((choice) => choice.id === selectedRuntime)) {
        await showNotice("That runtime is not available for this model. Choose a runtime again.");
        return;
      }
      pendingRuntime = selectedRuntime;
      // Pending IDs omit the bucket; recover browse position from the pending or current model.
      modelBucket ??= runtimeModel
        ? resolveDiscordModelPickerPageForModel({ data: pickerData, provider, model: runtimeModel })
            .bucket
        : undefined;
    } else {
      pendingRuntime = resolvePendingRuntime(provider);
      if (selectingModel && selectedModel) {
        modelBucket ??= resolveDiscordModelPickerPageForModel({
          data: pickerData,
          provider,
          model: selectedModel,
        }).bucket;
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
    const resolveSubmittedModelRef = (): string | null => {
      if (parsed.action === "reset") {
        return `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
      }
      if (parsed.modelToken) {
        return resolveDiscordModelPickerModelRefByToken(pickerData, parsed.modelToken);
      }
      if (parsed.action === "quick" || parsed.view === "recents") {
        if (requireModelToken) {
          return null;
        }
        const models =
          parsed.action === "quick"
            ? quickModels
            : getDiscordModelPickerRecentModelRefs(pickerData, quickModels);
        const slot = parsed.recentSlot ?? 0;
        return slot >= 1 ? (models[slot - 1] ?? null) : null;
      }

      const provider = parsed.provider;
      const selectedModel = resolveDiscordModelPickerModelSelection({
        data: pickerData,
        provider: provider ?? "",
        modelIndex: parsed.modelIndex,
        modelToken: parsed.modelToken,
        requireModelToken,
      });
      return provider && selectedModel ? `${provider}/${selectedModel}` : null;
    };
    const modelRef = resolveSubmittedModelRef();
    const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
    if (
      !parsedModelRef ||
      !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)
    ) {
      await showNotice(MODEL_PICKER_CHANGED_MESSAGE);
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
    const choices = getModelsRuntimeChoices(
      pickerData,
      parsedModelRef.provider,
      parsedModelRef.model,
    );
    if (choices === undefined) {
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
    const commandDefinition =
      findCommandByNativeName("model", "discord") ??
      listChatCommands().find((entry) => entry.key === "model");
    if (!commandDefinition) {
      await showNotice("Sorry, /model is unavailable right now.");
      return;
    }
    const commandArgs: CommandArgs = {
      values: { model: resolvedModelRef },
      raw: selectedRuntime ? `${resolvedModelRef} --runtime ${selectedRuntime}` : resolvedModelRef,
    };
    const prompt = buildCommandTextFromArgs(commandDefinition, commandArgs);

    const updateResult = await showNotice(`Applying model change to ${resolvedModelRef}...`, false);
    if (updateResult === null) {
      return;
    }

    if (pickerData.isCurrent?.() === false) {
      await showNotice("That model picker expired. Reopen /model to try again.");
      return;
    }
    const settleMs = ctx.postApplySettleMs ?? 250;
    const noticeMessage = await (async () => {
      const failureNotice = `❌ Failed to apply ${resolvedModelRef}. Try /model ${resolvedModelRef} directly.`;
      try {
        const dispatchResult = await withTimeout(
          params.dispatchCommandInteraction({
            readPolicy: ctx.readPolicy,
            interaction,
            prompt,
            command: commandDefinition,
            commandArgs,
            cfg,
            discordConfig: ctx.discordConfig,
            accountId: ctx.accountId,
            sessionPrefix: ctx.sessionPrefix,
            threadBindings: ctx.threadBindings,
            suppressReplies: true,
            buildContext: ctx.buildContext,
            dispatchReplyFromConfig: ctx.dispatchReplyFromConfig,
            pluginCommandDispatch: { kind: "non-plugin" },
          }),
          12000,
        );
        if (!dispatchResult.accepted) {
          return failureNotice;
        }
        const hiddenFinalReply = dispatchResult.hiddenFinalReply;
        const effectiveRoute = dispatchResult.effectiveRoute ?? route;
        if (settleMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, settleMs);
          });
        }

        const currentEntry = await createDiscordModelPickerSessionReader({
          cfg,
          route: effectiveRoute,
        })();
        const currentContext = {
          ...modelContext,
          route: effectiveRoute,
          sessionEntry: currentEntry,
        };
        const effectiveModelRef = await resolveDiscordModelPickerCurrentModel(currentContext);
        const effectiveRuntime = resolveDiscordModelPickerCurrentRuntime(currentContext);
        const currentSelection = `Current selection: ${effectiveModelRef} with runtime ${effectiveRuntime}.`;
        if (hiddenFinalReply?.isError) {
          return `${hiddenFinalReply.text?.trim()}\n${currentSelection}`;
        }
        const runtime = selectedRuntime?.trim();
        const expectedRuntime =
          runtime === "auto" || runtime === "default" ? "auto" : runtime || undefined;
        const verified =
          effectiveModelRef === resolvedModelRef &&
          (expectedRuntime === undefined || effectiveRuntime === expectedRuntime);
        if (verified) {
          await recordDiscordModelPickerRecentModel({
            scope: preferenceScope,
            modelRef: resolvedModelRef,
          }).catch(() => undefined);
        }

        return verified
          ? hiddenFinalReply?.text?.trim() || `✅ Model set to ${resolvedModelRef}.`
          : `⚠️ Tried to set ${resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""}, but current selection is ${effectiveModelRef} with runtime ${effectiveRuntime}.`;
      } catch (error) {
        if (error instanceof Error && error.message === "timeout") {
          return `⏳ Model change to ${resolvedModelRef} is still processing. Check /status in a few seconds.`;
        }
        return failureNotice;
      }
    })();

    const delivered = await params.safeInteractionCall("model picker follow-up", () =>
      interaction.followUp({
        ...buildDiscordModelPickerNoticePayload(noticeMessage),
        ephemeral: true,
      }),
    );
    if (delivered !== null) {
      await recordReply(prompt, noticeMessage, "selection");
    }
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
): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.Button,
    customId: `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`,

    async run(interaction: BaseComponentInteraction, data: ComponentData) {
      await handleDiscordModelPickerInteraction({ ...params, interaction, data });
    },
  };
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerFallbackParams,
): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.StringSelect,
    customId: `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`,

    async run(interaction: BaseComponentInteraction, data: ComponentData) {
      await handleDiscordModelPickerInteraction({ ...params, interaction, data });
    },
  };
}
