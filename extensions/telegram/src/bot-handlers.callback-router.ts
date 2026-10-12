import { randomUUID } from "node:crypto";
import type { Context } from "grammy";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import { applySessionModelSelection } from "openclaw/plugin-sdk/model-session-runtime";
import {
  formatModelsAvailableHeaderAsync,
  MODEL_PICKER_CHANGED_MESSAGE,
} from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { recordDeliveredCommandExchange } from "openclaw/plugin-sdk/session-transcript-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
} from "./approval-callback-data.js";
import { resolveAgentDir, resolveDefaultModelForAgent } from "./bot-handlers.agent.runtime.js";
import {
  createTelegramCallbackMessageActions,
  handleTelegramQuestionCallback,
  sendTelegramQuestionFeedback,
} from "./bot-handlers.callback-actions.js";
import {
  createTelegramCallbackApprovalRuntime,
  handleTelegramInteractiveCallback,
  isPermanentTelegramCallbackEditError,
  type TelegramCallbackMessageRuntime,
  TelegramRetryableCallbackError,
} from "./bot-handlers.callback-router-controls.js";
import type {
  TelegramEventAuthorizationMode,
  TelegramHandlerAuthorization,
} from "./bot-handlers.inbound-authorization.js";
import {
  buildSyntheticContext,
  buildSyntheticTextMessage,
} from "./bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import {
  resolveTelegramForumFlag,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramMessageThreadSpec,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import {
  getTelegramCallbackQueryAnswerPromise,
  startTelegramCallbackQueryAnswer,
} from "./callback-query-answer-state.js";
import { buildCommandsPaginationKeyboard } from "./command-ui.js";
import { escapeTelegramHtml } from "./format-html.js";
import { markdownToTelegramHtml } from "./format.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  parseModelCallbackData,
  resolveModelListCallback,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";
import {
  hasTelegramOpaqueCallbackPrefix,
  parseTelegramNativeCommandCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import { isTelegramMessageNotModifiedError } from "./network-errors.js";
import {
  hasTelegramQuestionCallbackPrefix,
  parseTelegramQuestionCallbackData,
} from "./question-callback-data.js";
import { buildInlineKeyboard } from "./send.js";
import { buildTelegramConversationId } from "./topic-conversation.js";

export function createTelegramCallbackRouter({
  params: {
    accountId,
    bot,
    runtime,
    telegramDeps,
    shouldSkipUpdate,
    nativeCommandCallbackDispatcher,
  },
  message: messageRuntime,
  authorization: authorizationRuntime,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramCallbackMessageRuntime;
  authorization: TelegramHandlerAuthorization;
}) {
  const { processMessageWithReplyChain } = messageRuntime;
  const {
    resolveTelegramEventAuthorizationContext,
    authorizeTelegramEventSender,
    isTelegramModelCallbackAuthorized,
  } = authorizationRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);

  const handleCallback = async (ctx: Context) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    const answerCallbackQuery = async () => {
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () => startTelegramCallbackQueryAnswer(bot, callback.id, false),
      }).catch(() => {});
    };
    const skipUpdate = shouldSkipUpdate(ctx);
    const data = (callback.data ?? "").trim();
    const typedQuestionCallback = parseTelegramQuestionCallbackData(data);
    const earlyAnswerPromise = getTelegramCallbackQueryAnswerPromise(ctx);
    if (earlyAnswerPromise) {
      await earlyAnswerPromise.catch(answerCallbackQuery);
    } else {
      await answerCallbackQuery();
    }
    if (skipUpdate) {
      return;
    }

    try {
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const hasReservedModelPrefix = data.startsWith("mdl1~");
      const hasReservedOpaquePrefix = hasTelegramOpaqueCallbackPrefix(data);
      const opaqueCallbackData = parseTelegramOpaqueCallbackData(callback.data?.trimStart());
      const genericCallbackText = data.startsWith("/") ? data : `callback_data: ${data}`;
      // Typed callback actions reach the agent as text only; `/`-prefixed values stay data,
      // never commands (commands use `action.type === "command"`).
      const callbackCommandText =
        nativeCallbackCommand ??
        (opaqueCallbackData ? `callback_data: ${opaqueCallbackData}` : genericCallbackText);
      const hasReservedApprovalPrefix = hasTelegramApprovalCallbackPrefix(data);
      const hasReservedQuestionPrefix = hasTelegramQuestionCallbackPrefix(data);
      const typedApprovalCallback = parseTelegramApprovalCallbackData(data);
      const legacyApprovalCallback = parseExecApprovalCommandText(
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : data),
      );
      const isApprovalCallback = hasReservedApprovalPrefix || legacyApprovalCallback !== null;
      const isRuntimeControlCallback = isApprovalCallback || hasReservedQuestionPrefix;
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: authorizationCfg,
        accountId,
      });
      const inlineButtonsUnavailable =
        inlineButtonsScope === "off" ||
        (inlineButtonsScope === "dm" && isGroup) ||
        (inlineButtonsScope === "group" && !isGroup);
      // Runtime controls retain their authorization after inline-button capability changes.
      // Stale typed controls cross this gate only to render their terminal result.
      if (
        !isRuntimeControlCallback &&
        inlineButtonsUnavailable &&
        !nativeCallbackCommand &&
        !hasReservedOpaquePrefix &&
        !hasReservedModelPrefix
      ) {
        return;
      }

      const isForum = await resolveTelegramForumFlag({
        chatId,
        chatType: callbackMessage.chat.type,
        isGroup,
        isForum: callbackMessage.chat.is_forum,
        isTopicMessage: callbackMessage.is_topic_message,
        getChat,
      });
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        cfg: authorizationCfg,
        chatId,
        isGroup,
        senderId,
        threadSpec: resolveTelegramMessageThreadSpec(callbackMessage, isForum),
      });
      const threadSpec = eventAuthContext.threadSpec;
      const { dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = (groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`,
        );
        return;
      }
      const actions = createTelegramCallbackMessageActions({
        bot,
        callbackMessage,
        threadSpec,
      });
      const clearRoutedCallbackButtons = async () => {
        try {
          await actions.clearCallbackButtons();
        } catch (editErr) {
          if (
            !isTelegramMessageNotModifiedError(editErr) &&
            !isPermanentTelegramCallbackEditError(editErr)
          ) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
      };
      const terminalizeUnavailableCallback = async () => {
        logVerbose("telegram: typed callback unavailable (handler missing or payload invalid)");
        await clearRoutedCallbackButtons();
        await actions.replyToCallbackChat("This action is no longer available.");
      };

      if (
        inlineButtonsUnavailable &&
        ((nativeCallbackCommand && !legacyApprovalCallback) ||
          hasReservedOpaquePrefix ||
          hasReservedModelPrefix)
      ) {
        await terminalizeUnavailableCallback();
        return;
      }
      if (nativeCallbackCommand && nativeCommandCallbackDispatcher) {
        const dispatch = await nativeCommandCallbackDispatcher({
          botUser: ctx.me,
          callbackQuery: callback,
          commandText: nativeCallbackCommand,
        });
        if (dispatch.handled) {
          if (dispatch.clearButtons) {
            await clearRoutedCallbackButtons();
          }
          return;
        }
      }
      const authorizationMode: TelegramEventAuthorizationMode = hasReservedQuestionPrefix
        ? "callback-runtime-allowlist"
        : !isGroup || (!isRuntimeControlCallback && inlineButtonsScope === "allowlist")
          ? "callback-allowlist"
          : "callback-scope";
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        mode: authorizationMode,
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
        return;
      }

      const callbackConversationId = buildTelegramConversationId({ chatId, thread: threadSpec });
      const callbackThreadId = threadSpec.id;
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const approvalRuntime = createTelegramCallbackApprovalRuntime({
        accountId,
        telegramDeps,
        runtimeCfg,
        senderId,
        actions,
      });
      const authorizeCallback = async () =>
        await isTelegramModelCallbackAuthorized({
          chatId,
          isGroup,
          senderId,
          context: eventAuthContext,
        });
      if (typedApprovalCallback) {
        await approvalRuntime.handleCanonical(typedApprovalCallback);
        return;
      }
      if (typedQuestionCallback) {
        await handleTelegramQuestionCallback({
          callback: typedQuestionCallback,
          cfg: runtimeCfg,
          senderId,
          feedback: async (text, mode) =>
            await sendTelegramQuestionFeedback({
              actions,
              text,
              mode,
              isGroup,
              user: callback.from,
            }),
        });
        return;
      }
      if (hasReservedQuestionPrefix) {
        return;
      }
      if (hasReservedApprovalPrefix) {
        await approvalRuntime.handleMalformedReserved();
        return;
      }
      if (
        !nativeCallbackCommand &&
        !hasReservedModelPrefix &&
        !inlineButtonsUnavailable &&
        (await handleTelegramInteractiveCallback({
          accountId,
          callback,
          ctx,
          callbackMessage,
          data,
          pluginCallbackData: opaqueCallbackData ?? data,
          callbackConversationId,
          callbackThreadId,
          senderId,
          senderUsername,
          isGroup,
          isForum,
          storeAllowFrom,
          actions,
          messageRuntime,
          authorizeCallback,
        }))
      ) {
        return;
      }
      if (legacyApprovalCallback) {
        await approvalRuntime.handleLegacy(legacyApprovalCallback);
        return;
      }
      // Unclaimed typed callbacks with a valid checksum fall through to the agent as
      // `callback_data: <value>`; only malformed payloads terminalize here.
      if (hasReservedOpaquePrefix && !opaqueCallbackData) {
        await terminalizeUnavailableCallback();
        return;
      }
      const { editCallbackMessage, editCallbackMessageWithButtons: editMessageWithButtons } =
        actions;
      const resolveSessionState = () =>
        messageRuntime.resolveTelegramSessionState({
          chatId,
          isGroup,
          threadSpec,
          botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
          senderId,
          runtimeCfg,
        });
      const retryModelAction = async <T>(action: () => Promise<T>): Promise<T> => {
        try {
          return await action();
        } catch (error) {
          throw new TelegramRetryableCallbackError(error);
        }
      };

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }
        const page = parseStrictPositiveInteger(pageValue);
        if (page === undefined) {
          return;
        }
        const agentId = paginationMatch[2]?.trim() || (await resolveSessionState()).agentId;
        const result = await retryModelAction(async () => {
          const skillCommands = await telegramDeps.prepareSkillCommandsForAgents({
            cfg: runtimeCfg,
            agentIds: [agentId],
          });
          return buildCommandsMessagePaginated(runtimeCfg, skillCommands, {
            page,
            forcePaginatedList: true,
            surface: "telegram",
          });
        });
        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;
        try {
          await editCallbackMessage(markdownToTelegramHtml(result.text), {
            parse_mode: "HTML",
            ...(keyboard ? { reply_markup: keyboard } : {}),
          });
        } catch (editErr) {
          if (!String(editErr).includes("message is not modified")) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
        const session = await resolveSessionState();
        await recordDeliveredCommandExchange({
          config: runtimeCfg,
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          expectedSessionId: session.sessionEntry?.sessionId,
          commandText: `/commands ${page}`,
          commandId: `telegram:${accountId}:${callback.id}`,
          replyId: String(callbackMessage.message_id),
          replyText: result.text,
        });
        return;
      }

      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        if (!(await authorizeCallback())) {
          logVerbose(
            `Blocked telegram model callback from ${senderId || "unknown"} (not authorized for /models)`,
          );
          return;
        }

        const { sessionState, modelData } = await retryModelAction(async () => {
          const session = await resolveSessionState();
          const providerData = await telegramDeps.buildModelsProviderData(
            runtimeCfg,
            session.agentId,
            {
              sessionEntry: session.sessionEntry,
            },
          );
          return { sessionState: session, modelData: providerData };
        });
        let commandText = "/model";
        const showModelReply = async (...args: Parameters<typeof editMessageWithButtons>) => {
          await editMessageWithButtons(...args);
          const [text, buttons] = args;
          await recordDeliveredCommandExchange({
            config: runtimeCfg,
            agentId: sessionState.agentId,
            sessionKey: sessionState.sessionKey,
            expectedSessionId: sessionState.sessionEntry?.sessionId,
            commandText,
            commandId: `telegram:${accountId}:${callback.id}`,
            replyId: String(callbackMessage.message_id),
            replyText: [
              text.replace(/<[^>]*>/g, ""),
              ...(buttons ?? []).map((row) => row.map((button) => button.text).join(", ")),
            ].join("\n"),
          });
        };
        const { byProvider, providers, resolvedDefault: activeResolvedDefault } = modelData;
        const providerInfos: ProviderInfo[] = providers.map((provider) => ({
          id: provider,
          count: byProvider.get(provider)?.size ?? 0,
        }));
        const showChangedModelPicker = () =>
          retryModelAction(() =>
            showModelReply(MODEL_PICKER_CHANGED_MESSAGE, buildProviderKeyboard(providerInfos)),
          );

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            await retryModelAction(() => showModelReply("No providers available.", []));
            return;
          }
          const notice = [...(modelData.modelMenu?.byProvider.values() ?? [])]
            .map((provider) => provider.notice)
            .filter(Boolean)
            .join("\n");
          await retryModelAction(() =>
            showModelReply(
              [modelData.refreshWarning, "Select a provider:", notice].filter(Boolean).join("\n\n"),
              buildProviderKeyboard(providerInfos),
            ),
          );
          return;
        }

        if (modelCallback.type === "list" || modelCallback.type === "list-ref") {
          const listSelection = resolveModelListCallback({ callback: modelCallback, providers });
          const modelSet = listSelection && byProvider.get(listSelection.provider);
          if (!listSelection || !modelSet || modelSet.size === 0) {
            await showChangedModelPicker();
            return;
          }
          const { provider, page } = listSelection;
          commandText = `/model ${provider} ${page}`;
          const models = [...modelSet].toSorted((left, right) => left.localeCompare(right));
          const totalPages = calculateTotalPages(models.length);
          const safePage = Math.max(1, Math.min(page, totalPages));
          const currentModel =
            sessionState.model ||
            `${activeResolvedDefault.provider}/${activeResolvedDefault.model}`;
          const availability = modelData.modelMenu?.byProvider.get(provider);
          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            modelNames: modelData.modelMenu?.modelNames ?? modelData.modelNames,
          });
          const text = `${await formatModelsAvailableHeaderAsync({
            provider,
            total: models.length,
            cfg: runtimeCfg,
            agentDir: resolveAgentDir(runtimeCfg, sessionState.agentId),
            sessionEntry: sessionState.sessionEntry,
            availability,
          })}\nSelecting a model also applies its configured runtime.`;
          await retryModelAction(() =>
            showModelReply([modelData.refreshWarning, text].filter(Boolean).join("\n\n"), buttons),
          );
          return;
        }

        const selection = resolveModelSelection({ callback: modelCallback, providers, byProvider });
        if (
          selection.kind !== "resolved" ||
          !byProvider.get(selection.provider)?.has(selection.model)
        ) {
          await showChangedModelPicker();
          return;
        }

        commandText = `/model ${selection.provider}/${selection.model}`;
        try {
          const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, {
            agentId: sessionState.agentId,
          });
          const resolvedDefault = resolveDefaultModelForAgent({
            cfg: runtimeCfg,
            agentId: sessionState.agentId,
          });
          const isDefaultSelection =
            selection.provider === resolvedDefault.provider &&
            selection.model === resolvedDefault.model;
          const persistedSessionEntry = sessionState.sessionEntry;
          const sessionEntryMissing = persistedSessionEntry === undefined;
          const sessionEntry = persistedSessionEntry ?? {
            sessionId: randomUUID(),
            updatedAt: Date.now(),
          };
          const previousAuthProfileId = sessionEntry.authProfileOverride?.trim();
          const sessionStore = { [sessionState.sessionKey]: sessionEntry };
          const currentModelRef = sessionState.model?.trim();
          const currentModelSeparator = currentModelRef?.indexOf("/") ?? -1;
          const currentSelection =
            currentModelRef && currentModelSeparator > 0
              ? {
                  provider: currentModelRef.slice(0, currentModelSeparator),
                  model: currentModelRef.slice(currentModelSeparator + 1),
                }
              : resolvedDefault;
          const applied = await retryModelAction(() =>
            applySessionModelSelection({
              cfg: runtimeCfg,
              agentId: sessionState.agentId,
              sessionKey: sessionState.sessionKey,
              storePath,
              sessionEntry,
              sessionStore,
              allowCreate: sessionEntryMissing,
              defaultProvider: resolvedDefault.provider,
              defaultModel: resolvedDefault.model,
              currentProvider: currentSelection.provider,
              currentModel: currentSelection.model,
              modelCatalog: modelData.modelCatalog,
              canPersistStickyModelSelection: false,
              request: {
                provider: selection.provider,
                model: selection.model,
                isDefault: isDefaultSelection,
                runtime: isDefaultSelection ? { kind: "clear" } : { kind: "unchanged" },
              },
              markLiveSwitchPending: true,
            }),
          );
          if (applied.status !== "applied") {
            await showModelReply(`❌ ${applied.message}`, []);
            return;
          }
          const defaultAuthProfileNotice =
            isDefaultSelection && previousAuthProfileId
              ? sessionStore[sessionState.sessionKey]?.authProfileOverride?.trim() ===
                previousAuthProfileId
                ? "Compatible auth profile retained."
                : "Incompatible auth profile cleared."
              : undefined;
          const actionText = isDefaultSelection
            ? "reset to default"
            : `changed to <b>${escapeTelegramHtml(selection.provider)}/${escapeTelegramHtml(selection.model)}</b>`;
          const runtimeText = `Runtime set to <b>${escapeTelegramHtml(applied.agentRuntime)}</b>${isDefaultSelection ? " from configured policy" : ""}.`;
          const scopeText = isDefaultSelection
            ? `Session model selection cleared.${defaultAuthProfileNotice ? ` ${defaultAuthProfileNotice}` : ""} ${runtimeText} New replies use the agent's configured default.`
            : `Session-only model selection. ${runtimeText} The agent default in openclaw.json is unchanged. This chat keeps the model selection across /new and /reset; use /model default -s to clear the session model selection.`;
          await showModelReply(`✅ Model ${actionText}\n\n${scopeText}`, [], {
            parse_mode: "HTML",
          });
        } catch (err) {
          if (err instanceof TelegramRetryableCallbackError) {
            throw err;
          }
          await showModelReply(`❌ Failed to change model: ${String(err)}`, []);
        }
        return;
      }
      if (hasReservedModelPrefix) {
        await terminalizeUnavailableCallback();
        return;
      }

      const hasCallbackInlineKeyboard =
        (callbackMessage.reply_markup?.inline_keyboard?.length ?? 0) > 0;
      if (hasCallbackInlineKeyboard) {
        await clearRoutedCallbackButtons();
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: withResolvedTelegramForumFlag(callbackMessage, isForum),
        from: callback.from,
        text: callbackCommandText,
      });
      const syntheticCtx = buildSyntheticContext(ctx, syntheticMessage);
      await processMessageWithReplyChain({
        ctx: syntheticCtx,
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom,
        options: {
          threadSpec,
          ...(nativeCallbackCommand ? { commandSource: "native" as const } : {}),
          forceWasMentioned: true,
          messageIdOverride: callback.id,
        },
      });
    } catch (err) {
      if (err instanceof TelegramRetryableCallbackError) {
        if (isPermanentTelegramCallbackEditError(err.cause)) {
          logVerbose(`telegram: swallowing permanent callback edit error: ${String(err.cause)}`);
          return;
        }
        runtime.error?.(danger(`callback handler failed: ${String(err)}`));
        throw err.cause;
      }
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
      }
    }
  };

  return { route: handleCallback };
}
