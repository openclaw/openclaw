import {
  loadPreparedModelCatalog,
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultModelForAgent,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  buildCommandTextFromArgs,
  canResolveCommandArgMenu,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  formatFastModeCurrentStatus,
  parseCommandArgs,
  resolveCommandArgMenuAsync,
  resolveEffectiveAgentRuntime,
  resolveFastModeState,
  resolveStoredModelOverrideAsync,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionEntryAsync,
  resolveStorePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  prepareTelegramCommandDispatch,
  type TelegramCommandExecutorParams,
} from "./bot-native-command-dispatch.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { buildTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

type TelegramCommandMenuModelContext = {
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  fastMode?: SessionEntry["fastMode"];
  sessionEntry?: SessionEntry;
};

async function resolveTelegramCommandMenuModelContext(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    modelParentSessionKey?: null;
  },
  mode: "menu" | "fast" = "menu",
): Promise<TelegramCommandMenuModelContext> {
  // Fast menus retain configured defaults even if session lookup fails.
  const fastDefault = mode === "fast" ? resolveDefaultModelForAgent(params) : undefined;
  const fallback = fastDefault ? { provider: fastDefault.provider, model: fastDefault.model } : {};
  if (!params.sessionKey.trim()) {
    return fallback;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const defaultModel = fastDefault ?? resolveDefaultModelForAgent(params);
    const entry = await getSessionEntryAsync({ storePath, sessionKey: params.sessionKey });
    const thinkingLevel = normalizeOptionalString(entry?.thinkingLevel);
    const fastMode = entry?.fastMode;
    let context: TelegramCommandMenuModelContext;
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      context = {
        provider: defaultModel.provider,
        model: defaultModel.model,
      };
    } else {
      const override = await resolveStoredModelOverrideAsync({
        sessionEntry: entry,
        loadSessionEntry: (sessionKey) => getSessionEntryAsync({ storePath, sessionKey }),
        sessionKey: params.sessionKey,
        parentSessionKey: entry?.parentSessionKey ?? params.modelParentSessionKey,
        defaultProvider: defaultModel.provider,
      });
      if (mode === "fast") {
        return {
          provider: override?.provider ?? defaultModel.provider,
          model: override?.model ?? defaultModel.model,
          sessionEntry: entry,
        };
      }
      if (override?.model) {
        context = {
          provider: override.provider || defaultModel.provider,
          model: override.model,
        };
      } else {
        const provider =
          normalizeOptionalString(entry?.providerOverride) ??
          normalizeOptionalString(entry?.modelProvider);
        const model =
          normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
        context = {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        };
      }
    }
    if (mode === "fast") {
      return { ...context, sessionEntry: entry };
    }
    return {
      ...context,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: context.provider ?? defaultModel.provider,
        modelId: context.model ?? defaultModel.model,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: entry,
      }),
    };
  } catch {
    return fallback;
  }
}

function resolveTelegramFastCommandState(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelContext: TelegramCommandMenuModelContext;
}) {
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  return resolveFastModeState({
    cfg: params.cfg,
    provider: params.modelContext.provider ?? defaultModel.provider,
    model: params.modelContext.model ?? defaultModel.model,
    agentId: params.agentId,
    sessionEntry: params.modelContext.sessionEntry,
  });
}

async function resolveTelegramThinkMenuCurrentLevel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  catalog: Awaited<ReturnType<typeof loadPreparedModelCatalog>>;
}): Promise<string> {
  const explicit = normalizeOptionalString(params.thinkingLevel);
  if (explicit) {
    return explicit;
  }
  const agentThinkingDefault = normalizeOptionalString(
    resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault,
  );
  if (agentThinkingDefault) {
    return agentThinkingDefault;
  }
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  return await resolveThinkingDefaultWithRuntimeCatalog({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider ?? defaultModel.provider,
    model: params.model ?? defaultModel.model,
    agentRuntime: params.agentRuntime,
    loadModelCatalog: async () => params.catalog,
  });
}

export type TelegramBuiltinCommandResult = "handled" | "handled-clear-buttons" | "fall-through";

export async function executeTelegramBuiltinCommand(
  params: TelegramCommandExecutorParams & {
    commandName: string;
    shouldSkip?: () => boolean;
  },
): Promise<TelegramBuiltinCommandResult> {
  // Loaded-registry lookup only: Telegram defines no resolveNativeCommandName
  // hook, and the bundled fallback would jiti-load the plugin source in dev/test.
  const commandDefinition = findCommandByNativeName(params.commandName, "telegram", {
    includeBundledChannelFallback: false,
  });
  if (!commandDefinition) {
    return "fall-through";
  }
  const commandArgs = parseCommandArgs(commandDefinition, params.rawText);
  const prompt = buildCommandTextFromArgs(commandDefinition, commandArgs);
  if (
    commandDefinition.key !== "login" &&
    !canResolveCommandArgMenu({ command: commandDefinition, args: commandArgs })
  ) {
    return "fall-through";
  }
  if (commandDefinition.key === "login" && params.shouldSkip?.()) {
    return "handled";
  }
  const dispatch = await prepareTelegramCommandDispatch({ ...params, requireAuth: true });
  if (!dispatch) {
    return "handled";
  }
  if (commandDefinition.key === "login") {
    const { executeTelegramLoginCommand } = await import("./bot-native-command-login.js");
    const currentProvider =
      (
        await resolveTelegramCommandMenuModelContext({
          cfg: dispatch.runtimeCfg,
          agentId: dispatch.route.agentId,
          sessionKey: dispatch.targetSessionKey,
          modelParentSessionKey: dispatch.modelParentSessionKey,
        })
      ).provider ??
      resolveDefaultModelForAgent({
        cfg: dispatch.runtimeCfg,
        agentId: dispatch.route.agentId,
      }).provider;
    const clearButtons = await executeTelegramLoginCommand({
      dispatch,
      commandText: prompt,
      currentProvider,
    });
    return clearButtons ? "handled-clear-buttons" : "handled";
  }

  const menuNeedsModelContext =
    commandDefinition.argsMenu &&
    !(commandArgs?.raw && !commandArgs.values) &&
    commandDefinition.args?.some(
      (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
    );
  const menuContextParams = {
    cfg: dispatch.runtimeCfg,
    agentId: dispatch.route.agentId,
    sessionKey: menuNeedsModelContext ? dispatch.targetSessionKey : "",
    modelParentSessionKey: dispatch.modelParentSessionKey,
  };
  const menuModelContext = menuNeedsModelContext
    ? await resolveTelegramCommandMenuModelContext(
        menuContextParams,
        commandDefinition.key === "fast" ? "fast" : "menu",
      )
    : {};
  // Native /think must not wait on provider discovery; persisted rows retain its metadata.
  const menuModelCatalog =
    commandDefinition.key === "think" && menuNeedsModelContext
      ? await loadPreparedModelCatalog({
          config: dispatch.runtimeCfg,
          agentId: dispatch.route.agentId,
          agentDir: resolveAgentDir(dispatch.runtimeCfg, dispatch.route.agentId),
          readOnly: true,
        })
      : undefined;
  const menu = await resolveCommandArgMenuAsync({
    command: commandDefinition,
    args: commandArgs,
    cfg: dispatch.runtimeCfg,
    session: { agentId: dispatch.route.agentId, sessionKey: dispatch.targetSessionKey },
    ...menuModelContext,
    catalog: menuModelCatalog,
  });
  if (menu) {
    // The tracker consumes the update; a menu with no choices must leave it for the pipeline.
    if (params.shouldSkip?.()) {
      return "handled";
    }
    const currentThinkingLevel =
      commandDefinition.key === "think"
        ? await resolveTelegramThinkMenuCurrentLevel({
            cfg: dispatch.runtimeCfg,
            agentId: dispatch.route.agentId,
            ...menuModelContext,
            catalog: menuModelCatalog ?? [],
          })
        : undefined;
    const currentFastModeStatus =
      commandDefinition.key === "fast"
        ? formatFastModeCurrentStatus(
            resolveTelegramFastCommandState({
              ...menuContextParams,
              modelContext: menuModelContext,
            }),
          )
        : undefined;
    let title = formatCommandArgMenuTitle({ command: commandDefinition, menu });
    if (commandDefinition.key === "think" && currentThinkingLevel) {
      title = `Current thinking level: ${currentThinkingLevel}.\n${title}`;
    } else if (commandDefinition.key === "fast" && currentFastModeStatus) {
      const options = menu.choices
        .map((choice) => choice.label.trim())
        .filter(Boolean)
        .join(", ");
      title = options ? `${currentFastModeStatus}\nOptions: ${options}.` : currentFastModeStatus;
    }
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let index = 0; index < menu.choices.length; index += 2) {
      rows.push(
        menu.choices.slice(index, index + 2).map((choice) => ({
          text: choice.label,
          callback_data: buildTelegramNativeCommandCallbackData(
            buildCommandTextFromArgs(commandDefinition, {
              values: { [menu.arg.name]: choice.value },
            }),
          ),
        })),
      );
    }
    const replyMarkup = buildInlineKeyboard(rows);
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: dispatch.runtime,
      fn: () =>
        dispatch.bot.api.sendMessage(dispatch.chatId, title, {
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...dispatch.threadParams,
        }),
    });
    await dispatch.recordDeliveredReply(
      prompt,
      `${title}\n${menu.choices.map((choice) => choice.label).join(", ")}`,
      "menu",
    );
    return "handled";
  }
  return "fall-through";
}
