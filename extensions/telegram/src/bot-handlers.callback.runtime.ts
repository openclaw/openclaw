// Telegram callback-query handling: approvals, plugin actions, selects, commands, and models.
import { randomUUID } from "node:crypto";
import type { Message } from "grammy/types";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import {
  applyModelOverrideToSessionEntry,
  ModelSelectionLockedError,
} from "openclaw/plugin-sdk/model-session-runtime";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { danger, logVerbose, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
  type TelegramApprovalCallback,
} from "./approval-callback-data.js";
import {
  buildTelegramCanonicalApprovalTerminalText,
  buildTelegramInvalidApprovalTerminalText,
  buildTelegramLegacyApprovalTerminalText,
} from "./approval-terminal.js";
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveDefaultModelForAgent,
} from "./bot-handlers.agent.runtime.js";
import type {
  TelegramEventAuthorizationMode,
  TelegramHandlerAuthorizationRuntime,
} from "./bot-handlers.authorization.runtime.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import { parseTelegramNativeCommandCallbackData } from "./bot-native-commands.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import {
  buildTelegramThreadParams,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  resolveTelegramThreadSpec,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import { getTelegramCallbackQueryAnswerPromise } from "./callback-query-answer-state.js";
import { buildCommandsPaginationKeyboard, buildTelegramModelsMenuButtons } from "./command-ui.js";
import {
  resolveTelegramApproval,
  resolveTelegramLegacyApproval,
} from "./exec-approval-resolver.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
} from "./exec-approvals.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { dispatchTelegramPluginInteractiveHandler } from "./interactive-dispatch.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";
import { parseTelegramOpaqueCallbackData } from "./native-command-callback-data.js";
import {
  isTelegramEditTargetMissingError,
  isTelegramMessageHasNoTextError,
} from "./network-errors.js";
import { buildInlineKeyboard } from "./send.js";

function isApprovalAlreadyResolvedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const record = error as {
    gatewayCode?: unknown;
    details?: { reason?: unknown } | null;
  };
  const reason = record.details?.reason;
  return (
    record.gatewayCode === "APPROVAL_ALREADY_RESOLVED" ||
    (record.gatewayCode === "INVALID_REQUEST" && reason === "APPROVAL_ALREADY_RESOLVED") ||
    /approval already resolved/i.test(error.message)
  );
}

export function registerTelegramCallbackQueryHandler(
  { accountId, bot, runtime, telegramDeps, shouldSkipUpdate }: RegisterTelegramHandlerParams,
  messageRuntime: TelegramHandlerMessageRuntime,
  authorizationRuntime: TelegramHandlerAuthorizationRuntime,
) {
  const {
    buildSyntheticTextMessage,
    buildSyntheticContext,
    buildFailedProcessingResult,
    resolveTelegramSessionState,
    processMessageWithReplyChain,
  } = messageRuntime;
  const {
    resolveTelegramEventAuthorizationContext,
    authorizeTelegramEventSender,
    isTelegramModelCallbackAuthorized,
  } = authorizationRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);
  const MULTI_SELECT_PREFIX = "OC_MULTI|";
  const MULTI_SELECT_TOGGLE_PREFIX = `${MULTI_SELECT_PREFIX}toggle|`;
  const SELECT_PREFIX = "OC_SELECT|";
  const SELECTED_PREFIX = "✅ ";

  type TelegramManagedSelectCallback =
    | { type: "multi-toggle"; value: string }
    | { type: "multi-clear" }
    | { type: "multi-submit" }
    | { type: "select"; value: string };

  type TelegramCallbackButton = {
    text: string;
    callback_data: string;
    style?: "danger" | "success" | "primary";
  };

  const parseTelegramManagedSelectCallback = (
    data: string,
  ): TelegramManagedSelectCallback | undefined => {
    if (data.startsWith(MULTI_SELECT_TOGGLE_PREFIX)) {
      return { type: "multi-toggle", value: data.slice(MULTI_SELECT_TOGGLE_PREFIX.length) };
    }
    if (data === `${MULTI_SELECT_PREFIX}clear`) {
      return { type: "multi-clear" };
    }
    if (data === `${MULTI_SELECT_PREFIX}submit`) {
      return { type: "multi-submit" };
    }
    if (data.startsWith(SELECT_PREFIX)) {
      return { type: "select", value: data.slice(SELECT_PREFIX.length) };
    }
    return undefined;
  };

  const cloneInlineKeyboardButtons = (message: Message): TelegramCallbackButton[][] => {
    const rows = (message as { reply_markup?: { inline_keyboard?: unknown } }).reply_markup
      ?.inline_keyboard;
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .map((row) =>
        Array.isArray(row)
          ? row
              .map((button): TelegramCallbackButton | null => {
                const candidate = button as {
                  text?: unknown;
                  callback_data?: unknown;
                  style?: unknown;
                };
                if (
                  typeof candidate.text !== "string" ||
                  typeof candidate.callback_data !== "string"
                ) {
                  return null;
                }
                const style =
                  candidate.style === "danger" ||
                  candidate.style === "success" ||
                  candidate.style === "primary"
                    ? candidate.style
                    : undefined;
                return {
                  text: candidate.text,
                  callback_data: candidate.callback_data,
                  ...(style ? { style } : {}),
                };
              })
              .filter((button): button is TelegramCallbackButton => button !== null)
          : [],
      )
      .filter((row) => row.length > 0);
  };
  const stripMultiSelectPrefix = (text: string): string => text.replace(/^✅\s*/, "");
  const isSelectedMultiButton = (button: TelegramCallbackButton): boolean =>
    /^✅\s*/.test(button.text);
  const isMultiToggleButton = (button: TelegramCallbackButton): boolean =>
    button.callback_data.startsWith(MULTI_SELECT_TOGGLE_PREFIX);
  const resolveMultiSelectedValues = (buttons: TelegramCallbackButton[][]): string[] =>
    buttons.flatMap((row) =>
      row.flatMap((button) => {
        if (!isMultiToggleButton(button) || !isSelectedMultiButton(button)) {
          return [];
        }
        return [button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length)];
      }),
    );
  const updateMultiSelectKeyboard = (
    message: Message,
    action: "toggle" | "clear",
    value = "",
  ): TelegramCallbackButton[][] =>
    cloneInlineKeyboardButtons(message).map((row) =>
      row.map((button) => {
        if (!isMultiToggleButton(button)) {
          return button;
        }
        const buttonValue = button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length);
        const baseText = stripMultiSelectPrefix(button.text);
        const selected =
          action === "clear"
            ? false
            : buttonValue === value
              ? !isSelectedMultiButton(button)
              : isSelectedMultiButton(button);
        return {
          ...button,
          text: selected ? `${SELECTED_PREFIX}${baseText}` : baseText,
        };
      }),
    );
  const buildCallbackSyntheticTextContext = (params: {
    ctx: Pick<TelegramContext, "me" | "getFile">;
    callbackMessage: Message;
    callback: { from?: Message["from"] };
    text: string;
    isForum: boolean;
  }): { ctx: TelegramContext; message: Message } => {
    const message = buildSyntheticTextMessage({
      base: withResolvedTelegramForumFlag(params.callbackMessage, params.isForum),
      from: params.callback.from,
      text: params.text,
    });
    return { ctx: buildSyntheticContext(params.ctx, message), message };
  };
  class TelegramRetryableCallbackError extends Error {
    public override readonly cause: unknown;

    constructor(cause: unknown) {
      super(String(cause));
      this.cause = cause;
      this.name = "TelegramRetryableCallbackError";
    }
  }

  const isPermanentTelegramCallbackEditError = (err: unknown): boolean =>
    isTelegramEditTargetMissingError(err) || isTelegramMessageHasNoTextError(err);

  const TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS = [250, 1000, 2500] as const;
  const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;

  const resolvePluginCallbackSubmitText = (submitText: unknown): string | undefined => {
    if (typeof submitText !== "string") {
      return undefined;
    }
    const trimmed = submitText.trim();
    return trimmed ? trimmed : undefined;
  };

  const isReplySessionInitConflictError = (err: unknown): boolean =>
    REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(String(err instanceof Error ? err.message : err));

  const isReplySessionInitConflictResult = (result: TelegramMessageProcessingResult): boolean =>
    result.kind === "failed-retryable" && isReplySessionInitConflictError(result.error);

  const processPluginCallbackSubmitText = async (params: {
    callbackId: string;
    syntheticCtx: Parameters<typeof processMessageWithReplyChain>[0]["ctx"];
    syntheticMessage: Parameters<typeof processMessageWithReplyChain>[0]["msg"];
    storeAllowFrom: Parameters<typeof processMessageWithReplyChain>[0]["storeAllowFrom"];
  }): Promise<"completed" | "skipped"> => {
    const spooledReplayParticipant = isTelegramSpooledReplayUpdate(params.syntheticCtx.update)
      ? (getTelegramSpooledReplayDeferredParticipant() ??
        createTelegramSpooledReplayDeferredParticipant(
          `plugin-callback-submit:${params.callbackId}`,
        ) ??
        undefined)
      : undefined;
    const settleFinalResult = (result: TelegramMessageProcessingResult) => {
      spooledReplayParticipant?.settle(result);
      return result.kind;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await processMessageWithReplyChain({
          ctx: params.syntheticCtx,
          msg: params.syntheticMessage,
          allMedia: [],
          storeAllowFrom: params.storeAllowFrom,
          options: {
            spooledReplay: true,
            isolateSpooledReplaySettlement: true,
            forceWasMentioned: true,
            messageIdOverride: params.callbackId,
          },
          spooledReplayAbortSignal: spooledReplayParticipant?.abortSignal,
        });
        if (result.kind === "completed") {
          settleFinalResult(result);
          return "completed";
        }
        if (result.kind === "skipped") {
          settleFinalResult(result);
          return "skipped";
        }
        const retryDelayMs = TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS[attempt];
        if (!isReplySessionInitConflictResult(result) || retryDelayMs === undefined) {
          throw new TelegramRetryableCallbackError(result.error);
        }
        logVerbose(
          `telegram plugin callback submitText hit active reply session; retrying in ${retryDelayMs}ms`,
        );
        await sleepWithAbort(retryDelayMs, spooledReplayParticipant?.abortSignal);
        continue;
      } catch (err) {
        const retryDelayMs = TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS[attempt];
        if (!isReplySessionInitConflictError(err) || retryDelayMs === undefined) {
          settleFinalResult(buildFailedProcessingResult(err));
          throw err;
        }
        logVerbose(
          `telegram plugin callback submitText hit active reply session; retrying in ${retryDelayMs}ms`,
        );
        await sleepWithAbort(retryDelayMs, spooledReplayParticipant?.abortSignal);
      }
    }
  };

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    const answerCallbackQuery = async () => {
      // Answer immediately to prevent Telegram from retrying while we process.
      // Pre-sequentialize middleware usually does this first; this remains the
      // fallback for failed early answers and direct handler tests.
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () => bot.api.answerCallbackQuery(callback.id),
      }).catch(() => {});
    };
    const earlyAnswerPromise = getTelegramCallbackQueryAnswerPromise(ctx);
    if (earlyAnswerPromise) {
      await earlyAnswerPromise.catch(answerCallbackQuery);
    } else {
      await answerCallbackQuery();
    }
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const callbackBusinessParams =
        callbackMessage.business_connection_id !== undefined
          ? { business_connection_id: callbackMessage.business_connection_id }
          : undefined;
      const withCallbackBusinessParams = <T extends object>(params: T) =>
        callbackBusinessParams ? { ...callbackBusinessParams, ...params } : params;
      const editCallbackMessage = async (
        text: string,
        params?: Parameters<typeof bot.api.editMessageText>[3],
      ) => {
        return await bot.api.editMessageText(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          text,
          params ? withCallbackBusinessParams(params) : callbackBusinessParams,
        );
      };
      const clearCallbackButtons = async () => {
        const emptyKeyboard = { inline_keyboard: [] };
        const replyMarkup = { reply_markup: emptyKeyboard };
        return await bot.api.editMessageReplyMarkup(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          withCallbackBusinessParams(replyMarkup),
        );
      };
      const editCallbackButtons = async (
        buttons: Array<
          Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
        >,
      ) => {
        const keyboard = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
        const replyMarkup = { reply_markup: keyboard };
        return await bot.api.editMessageReplyMarkup(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          withCallbackBusinessParams(replyMarkup),
        );
      };
      const deleteCallbackMessage = async () => {
        return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
      };
      const replyToCallbackChat = async (
        text: string,
        params?: Parameters<typeof bot.api.sendMessage>[2],
      ) => {
        const threadParams = buildTelegramThreadParams(
          resolveTelegramThreadSpec({
            isGroup,
            isForum,
            messageThreadId: callbackMessage.message_thread_id,
          }),
        );
        const topicParams = {
          ...callbackBusinessParams,
          ...threadParams,
          ...(callbackMessage.direct_messages_topic?.topic_id != null
            ? { direct_messages_topic_id: callbackMessage.direct_messages_topic.topic_id }
            : {}),
        };
        const replyParams =
          Object.keys(topicParams).length > 0 || params ? { ...topicParams, ...params } : params;
        return await bot.api.sendMessage(callbackMessage.chat.id, text, replyParams);
      };

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const opaqueCallbackData = parseTelegramOpaqueCallbackData(data);
      const genericCallbackText = data.startsWith("/") ? data : `callback_data: ${data}`;
      const callbackCommandText =
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : genericCallbackText);
      const pluginCallbackData = opaqueCallbackData ?? data;
      const hasReservedApprovalPrefix = hasTelegramApprovalCallbackPrefix(data);
      const typedApprovalCallback = parseTelegramApprovalCallbackData(data);
      const legacyApprovalCallback = parseExecApprovalCommandText(
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : data),
      );
      const isApprovalCallback = hasReservedApprovalPrefix || legacyApprovalCallback !== null;
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: authorizationCfg,
        accountId,
      });
      // Approval callbacks have their own kind-aware authorization below. Keep old
      // buttons usable after presentation capability changes without weakening auth.
      if (!isApprovalCallback) {
        if (inlineButtonsScope === "off") {
          return;
        }
        if (inlineButtonsScope === "dm" && isGroup) {
          return;
        }
        if (inlineButtonsScope === "group" && !isGroup) {
          return;
        }
      }

      const messageThreadId = callbackMessage.message_thread_id;
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
        isForum,
        senderId,
        messageThreadId,
      });
      const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = (groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`,
        );
        return;
      }
      const authorizationMode: TelegramEventAuthorizationMode =
        !isGroup || (!isApprovalCallback && inlineButtonsScope === "allowlist")
          ? "callback-allowlist"
          : "callback-scope";
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: authorizationMode,
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
        return;
      }

      const callbackThreadId = resolvedThreadId ?? dmThreadId;
      const callbackConversationId =
        callbackThreadId != null ? `${chatId}:topic:${callbackThreadId}` : String(chatId);
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const resolveApprovalAuthorizations = () => {
        const pluginApprovalAuthorizedSender = isTelegramExecApprovalApprover({
          cfg: runtimeCfg,
          accountId,
          senderId,
        });
        const execApprovalAuthorizedSender = isTelegramExecApprovalAuthorizedSender({
          cfg: runtimeCfg,
          accountId,
          senderId,
        });
        return { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender };
      };
      const clearTerminalApprovalButtons = async () => {
        try {
          // First-answer-wins returns applied:false to losing surfaces. Their controls
          // are stale too, so cleanup follows canonical terminal truth, not local authorship.
          await clearCallbackButtons();
        } catch (editErr) {
          const errStr = String(editErr);
          if (
            errStr.includes("message is not modified") ||
            errStr.includes("there is no text in the message to edit")
          ) {
            return;
          }
          logVerbose(`telegram: failed to clear approval callback buttons: ${errStr}`);
        }
      };
      const terminalizeApprovalMessage = async (text: string) => {
        try {
          await editCallbackMessage(text, {
            reply_markup: { inline_keyboard: [] },
          });
          return;
        } catch (editErr) {
          const errStr = String(editErr);
          const alreadyTerminal = errStr.includes("message is not modified");
          if (!alreadyTerminal) {
            logVerbose(`telegram: failed to render terminal approval receipt: ${errStr}`);
          }
          // Preserve the terminal state even when Telegram no longer permits a text edit.
          await clearTerminalApprovalButtons();
          if (alreadyTerminal) {
            return;
          }
        }
        try {
          await replyToCallbackChat(text);
        } catch (sendErr) {
          logVerbose(`telegram: failed to send terminal approval receipt: ${String(sendErr)}`);
        }
      };
      const resolveCanonicalApproval = async (approvalCallback: TelegramApprovalCallback) =>
        await (telegramDeps.resolveApproval ?? resolveTelegramApproval)({
          cfg: runtimeCfg,
          approvalId: approvalCallback.approvalId,
          approvalKind: approvalCallback.approvalKind,
          decision: approvalCallback.decision,
          senderId,
        });
      const terminalizeCanonicalApproval = async (
        approvalCallback: TelegramApprovalCallback,
        result: Awaited<ReturnType<typeof resolveCanonicalApproval>>,
      ) =>
        await terminalizeApprovalMessage(
          buildTelegramCanonicalApprovalTerminalText({
            result,
            fallbackApprovalId: approvalCallback.approvalId,
          }),
        );
      const handleApprovalCallback = async (approvalCallback: TelegramApprovalCallback) => {
        const { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender } =
          resolveApprovalAuthorizations();
        const authorizedApprovalSender =
          approvalCallback.approvalKind === "plugin"
            ? pluginApprovalAuthorizedSender
            : execApprovalAuthorizedSender || pluginApprovalAuthorizedSender;
        if (!authorizedApprovalSender) {
          logVerbose(
            `Blocked telegram approval callback from ${senderId || "unknown"} (not authorized)`,
          );
          return;
        }
        try {
          const result = await resolveCanonicalApproval(approvalCallback);
          if (!result.applied) {
            logVerbose(
              `telegram: approval callback already resolved ${approvalCallback.approvalId} ` +
                `status=${result.approval.status}`,
            );
          }
          await terminalizeCanonicalApproval(approvalCallback, result);
        } catch (resolveErr) {
          const errStr = String(resolveErr);
          logVerbose(
            `telegram: failed to resolve approval callback ${approvalCallback.approvalId}: ${errStr}`,
          );
          if (isApprovalNotFoundError(resolveErr) || isApprovalAlreadyResolvedError(resolveErr)) {
            await terminalizeApprovalMessage(
              buildTelegramLegacyApprovalTerminalText({
                approvalId: approvalCallback.approvalId,
                outcome: "no-longer-pending",
              }),
            );
            return;
          }
          throw new TelegramRetryableCallbackError(resolveErr);
        }
      };
      const handleLegacyApprovalCallback = async (
        approvalCallback: NonNullable<typeof legacyApprovalCallback>,
      ) => {
        const { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender } =
          resolveApprovalAuthorizations();
        const approvalKinds: Array<"exec" | "plugin"> = [];
        if (execApprovalAuthorizedSender || pluginApprovalAuthorizedSender) {
          approvalKinds.push("exec");
        }
        if (pluginApprovalAuthorizedSender) {
          approvalKinds.push("plugin");
        }
        if (approvalKinds.length === 0) {
          logVerbose(
            `Blocked telegram approval callback from ${senderId || "unknown"} (not authorized)`,
          );
          return;
        }

        const resolveLegacy = telegramDeps.resolveLegacyApproval ?? resolveTelegramLegacyApproval;
        for (const approvalKind of approvalKinds) {
          const canonicalCallback: TelegramApprovalCallback = {
            type: "approval",
            approvalId: approvalCallback.approvalId,
            approvalKind,
            decision: approvalCallback.decision,
          };
          try {
            // Legacy command/value callbacks never carried an owner. Probe only adapters
            // this sender may use, in fixed order independent of approval id spelling.
            await resolveLegacy({
              cfg: runtimeCfg,
              approvalId: approvalCallback.approvalId,
              approvalKind,
              decision: approvalCallback.decision,
              senderId,
            });
            await terminalizeApprovalMessage(
              buildTelegramLegacyApprovalTerminalText({
                approvalId: approvalCallback.approvalId,
                decision: approvalCallback.decision,
                outcome: "resolved-here",
              }),
            );
            return;
          } catch (resolveErr) {
            if (isApprovalNotFoundError(resolveErr)) {
              // Legacy callbacks have no owner kind. The kind-specific adapters are the
              // lookup: canonical resolve is mutating and must never receive a guessed kind.
              continue;
            }
            if (isApprovalAlreadyResolvedError(resolveErr)) {
              try {
                const result = await resolveCanonicalApproval(canonicalCallback);
                await terminalizeCanonicalApproval(canonicalCallback, result);
              } catch (canonicalError) {
                if (
                  !isApprovalNotFoundError(canonicalError) &&
                  !isApprovalAlreadyResolvedError(canonicalError)
                ) {
                  throw new TelegramRetryableCallbackError(canonicalError);
                }
                logVerbose(
                  `telegram: canonical approval lookup failed after stale legacy callback ` +
                    `${approvalCallback.approvalId}: ${String(canonicalError)}`,
                );
                await terminalizeApprovalMessage(
                  buildTelegramLegacyApprovalTerminalText({
                    approvalId: approvalCallback.approvalId,
                    outcome: "no-longer-pending",
                  }),
                );
              }
              return;
            }
            logVerbose(
              `telegram: failed to resolve approval callback ${approvalCallback.approvalId}: ${String(resolveErr)}`,
            );
            throw new TelegramRetryableCallbackError(resolveErr);
          }
        }

        logVerbose(`telegram: approval callback not found ${approvalCallback.approvalId}`);
        if (!pluginApprovalAuthorizedSender) {
          // Legacy callbacks carry no owner kind. An exec-only reviewer cannot
          // clear controls that may still belong to a plugin approval.
          return;
        }
        await terminalizeApprovalMessage(
          buildTelegramLegacyApprovalTerminalText({
            approvalId: approvalCallback.approvalId,
            outcome: pluginApprovalAuthorizedSender ? "no-longer-pending" : "not-actionable",
          }),
        );
      };

      if (typedApprovalCallback) {
        await handleApprovalCallback(typedApprovalCallback);
        return;
      }
      if (hasReservedApprovalPrefix) {
        const { execApprovalAuthorizedSender, pluginApprovalAuthorizedSender } =
          resolveApprovalAuthorizations();
        if (!execApprovalAuthorizedSender && !pluginApprovalAuthorizedSender) {
          logVerbose(
            `Blocked malformed telegram approval callback from ${senderId || "unknown"} (not authorized)`,
          );
          return;
        }
        logVerbose(`telegram: consumed malformed reserved approval callback from ${senderId}`);
        await terminalizeApprovalMessage(buildTelegramInvalidApprovalTerminalText());
        return;
      }

      const pluginBindingApproval = parsePluginBindingApprovalCustomId(data);
      if (pluginBindingApproval) {
        let resolved: Awaited<ReturnType<typeof resolvePluginConversationBindingApproval>>;
        try {
          resolved = await resolvePluginConversationBindingApproval({
            approvalId: pluginBindingApproval.approvalId,
            decision: pluginBindingApproval.decision,
            senderId: senderId || undefined,
          });
        } catch (err) {
          throw new TelegramRetryableCallbackError(err);
        }
        await clearCallbackButtons();
        await replyToCallbackChat(buildPluginBindingResolvedText(resolved));
        return;
      }
      const pluginCallback = await dispatchTelegramPluginInteractiveHandler({
        data: pluginCallbackData,
        callbackId: callback.id,
        ctx: {
          accountId,
          callbackId: callback.id,
          conversationId: callbackConversationId,
          parentConversationId: callbackThreadId != null ? String(chatId) : undefined,
          senderId: senderId || undefined,
          senderUsername: senderUsername || undefined,
          threadId: callbackThreadId,
          isGroup,
          isForum,
          auth: {
            isAuthorizedSender: await isTelegramModelCallbackAuthorized({
              chatId,
              isGroup,
              senderId,
              senderUsername,
              context: eventAuthContext,
            }),
          },
          callbackMessage: {
            messageId: callbackMessage.message_id,
            chatId: String(chatId),
            messageText: callbackMessage.text ?? callbackMessage.caption,
          },
        },
        respond: {
          reply: async ({ text, buttons }) => {
            await replyToCallbackChat(
              text,
              buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
            );
          },
          editMessage: async ({ text, buttons }) => {
            await editCallbackMessage(
              text,
              buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
            );
          },
          editButtons: async ({ buttons }) => {
            await editCallbackButtons(buttons);
          },
          clearButtons: async () => {
            await clearCallbackButtons();
          },
          deleteMessage: async () => {
            await deleteCallbackMessage();
          },
        },
        afterInvoke: async (result) => {
          if (result?.handled === false) {
            return;
          }
          const submitText = resolvePluginCallbackSubmitText(result?.submitText);
          if (!submitText) {
            return;
          }
          const { ctx: syntheticCtx, message: syntheticMessage } =
            buildCallbackSyntheticTextContext({
              ctx,
              callbackMessage,
              callback,
              text: submitText,
              isForum,
            });
          const submitOutcome = await processPluginCallbackSubmitText({
            callbackId: callback.id,
            syntheticCtx,
            syntheticMessage,
            storeAllowFrom,
          });
          if (submitOutcome === "skipped") {
            return;
          }
          // The agent turn already completed. Cleanup failure must not release
          // callback dedupe and replay the submitted turn.
          await clearCallbackButtons().catch((err: unknown) => {
            logVerbose(`telegram plugin callback button cleanup skipped: ${String(err)}`);
          });
        },
      });
      if (pluginCallback.handled) {
        return;
      }

      const managedSelectCallback = parseTelegramManagedSelectCallback(data);
      if (managedSelectCallback) {
        if (
          managedSelectCallback.type === "multi-toggle" ||
          managedSelectCallback.type === "multi-clear"
        ) {
          const buttons = updateMultiSelectKeyboard(
            callbackMessage,
            managedSelectCallback.type === "multi-clear" ? "clear" : "toggle",
            managedSelectCallback.type === "multi-toggle" ? managedSelectCallback.value : "",
          );
          if (buttons.length > 0) {
            try {
              await editCallbackButtons(buttons);
            } catch (editErr) {
              if (!String(editErr).includes("message is not modified")) {
                throw new TelegramRetryableCallbackError(editErr);
              }
            }
          }
          return;
        }

        if (managedSelectCallback.type === "multi-submit") {
          const selected = resolveMultiSelectedValues(cloneInlineKeyboardButtons(callbackMessage));
          const synthetic = buildCallbackSyntheticTextContext({
            ctx,
            callbackMessage,
            callback,
            text: `Multi-select submitted: ${selected.length > 0 ? selected.join(", ") : "none"}`,
            isForum,
          });
          await processMessageWithReplyChain({
            ctx: synthetic.ctx,
            msg: synthetic.message,
            allMedia: [],
            storeAllowFrom,
            options: {
              forceWasMentioned: true,
              messageIdOverride: callback.id,
            },
          });
          return;
        }

        try {
          await clearCallbackButtons();
        } catch (editErr) {
          const errStr = String(editErr);
          if (
            !errStr.includes("message is not modified") &&
            !errStr.includes("there is no text in the message to edit")
          ) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
        const synthetic = buildCallbackSyntheticTextContext({
          ctx,
          callbackMessage,
          callback,
          text: `Single-select submitted: ${managedSelectCallback.value}`,
          isForum,
        });
        await processMessageWithReplyChain({
          ctx: synthetic.ctx,
          msg: synthetic.message,
          allMedia: [],
          storeAllowFrom,
          options: {
            forceWasMentioned: true,
            messageIdOverride: callback.id,
          },
        });
        return;
      }

      if (legacyApprovalCallback) {
        await handleLegacyApprovalCallback(legacyApprovalCallback);
        return;
      }

      if (opaqueCallbackData) {
        return;
      }

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

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(runtimeCfg);
        let result: ReturnType<typeof buildCommandsMessagePaginated>;
        try {
          const skillCommands = telegramDeps.listSkillCommandsForAgents({
            cfg: runtimeCfg,
            agentIds: [agentId],
          });
          result = buildCommandsMessagePaginated(runtimeCfg, skillCommands, {
            page,
            forcePaginatedList: true,
            surface: "telegram",
          });
        } catch (err) {
          throw new TelegramRetryableCallbackError(err);
        }

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : undefined);
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
        return;
      }

      // Model selection callback handler (mdl_prov, mdl_list_*, mdl_sel_*, mdl_back)
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        if (
          !(await isTelegramModelCallbackAuthorized({
            chatId,
            isGroup,
            senderId,
            senderUsername,
            context: eventAuthContext,
          }))
        ) {
          logVerbose(
            `Blocked telegram model callback from ${senderId || "unknown"} (not authorized for /models)`,
          );
          return;
        }
        let sessionState: ReturnType<typeof resolveTelegramSessionState>;
        let modelData: Awaited<ReturnType<typeof telegramDeps.buildModelsProviderData>>;
        try {
          // Retry only the callback preflight that happens before any visible chat mutation.
          sessionState = resolveTelegramSessionState({
            chatId,
            isGroup,
            isForum,
            messageThreadId,
            resolvedThreadId,
            botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
            senderId,
            runtimeCfg,
          });
          modelData = await telegramDeps.buildModelsProviderData(runtimeCfg, sessionState.agentId);
        } catch (err) {
          throw new TelegramRetryableCallbackError(err);
        }
        const {
          byProvider,
          providers,
          modelNames,
          resolvedDefault: activeResolvedDefault,
        } = modelData;

        const editMessageWithButtons = async (
          text: string,
          buttons: ReturnType<typeof buildProviderKeyboard>,
          extra?: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2" },
        ) => {
          const keyboard = buildInlineKeyboard(buttons);
          const editParams = keyboard ? { reply_markup: keyboard, ...extra } : extra;
          try {
            await editCallbackMessage(text, editParams);
          } catch (editErr) {
            const errStr = String(editErr);
            if (errStr.includes("no text in the message")) {
              try {
                await deleteCallbackMessage();
              } catch {}
              await replyToCallbackChat(
                text,
                keyboard ? { reply_markup: keyboard, ...extra } : extra,
              );
            } else if (!errStr.includes("message is not modified")) {
              throw editErr;
            }
          }
        };

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            try {
              await editMessageWithButtons("No providers available.", []);
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }
          const providerInfos: ProviderInfo[] = providers.map((p) => ({
            id: p,
            count: byProvider.get(p)?.size ?? 0,
          }));
          const buttons = buildTelegramModelsMenuButtons({ providers: providerInfos });
          try {
            await editMessageWithButtons("Select a provider:", buttons);
          } catch (err) {
            throw new TelegramRetryableCallbackError(err);
          }
          return;
        }

        if (modelCallback.type === "list") {
          const { provider, page } = modelCallback;
          const modelSet = byProvider.get(provider);
          if (!modelSet || modelSet.size === 0) {
            // Provider not found or no models - show providers list
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildTelegramModelsMenuButtons({ providers: providerInfos });
            try {
              await editMessageWithButtons(
                `Unknown provider: ${provider}\n\nSelect a provider:`,
                buttons,
              );
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }
          const models = [...modelSet].toSorted((left, right) => left.localeCompare(right));
          const pageSize = getModelsPageSize();
          const totalPages = calculateTotalPages(models.length, pageSize);
          const safePage = Math.max(1, Math.min(page, totalPages));

          // Resolve current model from session (prefer overrides), then the active default.
          const currentModel =
            sessionState.model ||
            `${activeResolvedDefault.provider}/${activeResolvedDefault.model}`;

          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            pageSize,
            modelNames,
          });
          const text = formatModelsAvailableHeader({
            provider,
            total: models.length,
            cfg: runtimeCfg,
            agentDir: resolveAgentDir(runtimeCfg, sessionState.agentId),
            sessionEntry: sessionState.sessionEntry,
          });
          try {
            await editMessageWithButtons(text, buttons);
          } catch (err) {
            throw new TelegramRetryableCallbackError(err);
          }
          return;
        }

        if (modelCallback.type === "select") {
          const selection = resolveModelSelection({
            callback: modelCallback,
            providers,
            byProvider,
          });
          if (selection.kind !== "resolved") {
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildTelegramModelsMenuButtons({ providers: providerInfos });
            try {
              await editMessageWithButtons(
                `Could not resolve model "${selection.model}".\n\nSelect a provider:`,
                buttons,
              );
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }

          const modelSet = byProvider.get(selection.provider);
          if (!modelSet?.has(selection.model)) {
            try {
              await editMessageWithButtons(
                `❌ Model "${selection.provider}/${selection.model}" is not allowed.`,
                [],
              );
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }

          // Directly set model override in session
          try {
            // Use the fresh runtimeCfg (loaded at callback entry) so store path
            // and default-model resolution stay consistent with the next
            // inbound message.  The outer `cfg` is a snapshot captured at
            // handler-registration time and becomes stale after config reloads,
            // which can cause the override to be written to the wrong store or
            // incorrectly treated as the default model (clearing the override).
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

            try {
              await patchSessionEntry({
                storePath,
                sessionKey: sessionState.sessionKey,
                fallbackEntry: {
                  sessionId: randomUUID(),
                  updatedAt: Date.now(),
                },
                replaceEntry: true,
                update: (entry) => {
                  applyModelOverrideToSessionEntry({
                    entry,
                    selection: {
                      provider: selection.provider,
                      model: selection.model,
                      isDefault: isDefaultSelection,
                    },
                  });
                  return entry;
                },
              });
            } catch (err) {
              if (err instanceof ModelSelectionLockedError) {
                try {
                  await editMessageWithButtons(`❌ ${err.message}`, []);
                } catch (editErr) {
                  throw new TelegramRetryableCallbackError(editErr);
                }
                return;
              }
              throw new TelegramRetryableCallbackError(err);
            }

            // Update message to show success with visual feedback
            const escapeHtml = (text: string) =>
              text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const actionText = isDefaultSelection
              ? "reset to default"
              : `changed to <b>${escapeHtml(selection.provider)}/${escapeHtml(selection.model)}</b>`;
            const scopeText = isDefaultSelection
              ? "Session selection cleared. Runtime unchanged. New replies use the agent's configured default."
              : `Session-only model selection. Runtime unchanged. Use /model ${escapeHtml(selection.provider)}/${escapeHtml(selection.model)} --runtime &lt;runtime&gt; to switch harnesses. The agent default in openclaw.json is unchanged; /reset or a new session may return to that default.`;
            await editMessageWithButtons(
              `✅ Model ${actionText}\n\n${scopeText}`,
              [], // Empty buttons = remove inline keyboard
              { parse_mode: "HTML" },
            );
          } catch (err) {
            if (err instanceof TelegramRetryableCallbackError) {
              throw err;
            }
            await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
          }
          return;
        }

        return;
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
  });
}
