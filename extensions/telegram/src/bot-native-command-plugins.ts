import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginCommandNativeCandidate } from "openclaw/plugin-sdk/plugin-command-runtime";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  formatSqliteSessionFileMarker,
  getSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  prepareTelegramCommandDispatch,
  resolveTelegramNativeCommandThreadContext,
  type TelegramCommandExecutorParams,
} from "./bot-native-command-dispatch.js";
import { buildTelegramRoutingTarget, buildTelegramGroupFrom } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordSentMessage } from "./sent-message-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

type TelegramNativeReplyPayload = import("openclaw/plugin-sdk/plugin-entry").PluginCommandResult;
type TelegramNativeReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
  reaction?: { emoji?: unknown };
};

function inspectTelegramNativeReply(result: TelegramNativeReplyPayload) {
  const telegramData = result.channelData?.telegram as TelegramNativeReplyChannelData | undefined;
  const hasReaction = Boolean(normalizeOptionalString(telegramData?.reaction?.emoji));
  const { channelData: _channelData, ...portableContent } = result;
  return {
    telegramData,
    hasReaction,
    renderable:
      hasOutboundReplyContent(portableContent, { trimText: true }) ||
      Boolean(buildInlineKeyboard(telegramData?.buttons) || hasReaction),
    editable:
      !result.mediaUrl &&
      (!result.mediaUrls || result.mediaUrls.length === 0) &&
      !result.presentation &&
      !result.interactive &&
      !result.btw &&
      !hasReaction &&
      telegramData?.pin !== true,
  };
}

async function resolveTelegramCommandTranscriptContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): Promise<{ sessionId?: string; sessionFile?: string; authProfileId?: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = getSessionEntry({ agentId: params.agentId, sessionKey, storePath });
    const sessionId = entry?.sessionId?.trim() || randomUUID();
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: params.agentId,
      sessionId,
      storePath,
    });
    const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
    return { sessionId, sessionFile, ...(authProfileId ? { authProfileId } : {}) };
  } catch {
    return {};
  }
}

export async function executeTelegramPluginCommand(
  params: TelegramCommandExecutorParams & {
    commandName: string;
    candidate: PluginCommandNativeCandidate;
  },
): Promise<void> {
  const commandBody = `/${params.commandName}${params.rawText ? ` ${params.rawText}` : ""}`;
  const pluginCommandDispatch = params.candidate.prepareDispatch(params.rawText);
  if (pluginCommandDispatch.kind === "non-plugin") {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: params.runtime,
      fn: async () =>
        await params.bot.api.sendMessage(
          params.msg.chat.id,
          "Command not found.",
          (await resolveTelegramNativeCommandThreadContext(params)).threadParams ?? {},
        ),
    });
    return;
  }
  const dispatch = await prepareTelegramCommandDispatch({
    ...params,
    requireAuth: params.candidate.requireAuth,
  });
  if (!dispatch) {
    return;
  }
  const targetSessionEntry = await dispatch.nativeCommandRuntime.getSessionEntryAsync({
    agentId: dispatch.route.agentId,
    sessionKey: dispatch.targetSessionKey,
    storePath: dispatch.nativeCommandRuntime.resolveStorePath(dispatch.runtimeCfg.session?.store, {
      agentId: dispatch.route.agentId,
    }),
  });
  const from = dispatch.isGroup
    ? buildTelegramGroupFrom(dispatch.chatId, dispatch.threadSpec)
    : `telegram:${dispatch.chatId}`;
  const to =
    dispatch.threadSpec.scope === "direct-messages"
      ? buildTelegramRoutingTarget(dispatch.chatId, dispatch.threadSpec)
      : `telegram:${dispatch.chatId}`;
  const { deliverReplies, emitTelegramMessageSentHooks } = await dispatch.loadDeliveryRuntime();
  let progressMessageId: number | undefined;
  const cleanupProgressPlaceholder = async () => {
    const messageId = progressMessageId;
    if (messageId == null) {
      return;
    }
    try {
      await withTelegramApiErrorLogging({
        operation: "deleteMessage",
        runtime: dispatch.runtime,
        fn: () => dispatch.bot.api.deleteMessage(dispatch.chatId, messageId),
      });
    } catch {
      // Best-effort cleanup before fallback or suppression exits.
    }
  };
  if (params.candidate.progressMessage) {
    try {
      const sent = await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime: dispatch.runtime,
        fn: () =>
          dispatch.bot.api.sendMessage(
            dispatch.chatId,
            params.candidate.progressMessage!,
            dispatch.threadParams,
          ),
      });
      progressMessageId = sent.message_id;
    } catch {
      // Fall back to the normal final reply path if the placeholder send fails.
    }
  }
  const transcriptContext = await resolveTelegramCommandTranscriptContext({
    cfg: dispatch.runtimeCfg,
    agentId: dispatch.route.agentId,
    sessionKey: dispatch.targetSessionKey,
  });
  const result = await pluginCommandDispatch.execute({
    senderId: dispatch.senderId,
    channel: "telegram",
    isAuthorizedSender: dispatch.commandAuthorized,
    senderIsOwner: dispatch.senderIsOwner,
    assertOwnerCurrent: dispatch.assertOwnerCurrent,
    agentId: dispatch.route.agentId,
    sessionKey: dispatch.targetSessionKey,
    sessionId: transcriptContext.sessionId,
    sessionFile: transcriptContext.sessionFile,
    authProfileId: transcriptContext.authProfileId ?? targetSessionEntry?.authProfileOverride,
    commandBody,
    config: dispatch.runtimeCfg,
    from,
    to,
    accountId: dispatch.accountId,
    messageThreadId: dispatch.threadSpec.id,
  });
  const suppressReply =
    shouldSuppressLocalTelegramExecApprovalPrompt({
      cfg: dispatch.runtimeCfg,
      accountId: dispatch.route.accountId,
      payload: result,
    }) || result.suppressReply === true;
  if (suppressReply) {
    await cleanupProgressPlaceholder();
    return;
  }
  const { hasReaction, renderable, editable, telegramData } = inspectTelegramNativeReply(result);
  const deliverableResult: TelegramNativeReplyPayload = renderable
    ? hasReaction && !normalizeOptionalString(result.replyToId)
      ? { ...result, replyToId: String(dispatch.msg.message_id) }
      : result
    : { text: EMPTY_RESPONSE_FALLBACK };
  const progressResultText = deliverableResult.text;
  if (
    progressMessageId != null &&
    dispatch.telegramDeps.editMessageTelegram &&
    typeof progressResultText === "string" &&
    progressResultText.trim().length > 0 &&
    (!renderable || editable)
  ) {
    try {
      await dispatch.telegramDeps.editMessageTelegram(
        dispatch.chatId,
        progressMessageId,
        progressResultText,
        {
          cfg: dispatch.runtimeCfg,
          accountId: dispatch.route.accountId,
          textMode: "markdown",
          linkPreview: dispatch.runtimeTelegramCfg.linkPreview,
          buttons: renderable ? telegramData?.buttons : undefined,
        },
      );
      await recordSentMessage(dispatch.chatId, progressMessageId, dispatch.runtimeCfg, {
        accountId: dispatch.route.accountId,
        agentId: dispatch.opts.ownerAgentId,
      });
      emitTelegramMessageSentHooks({
        sessionKeyForInternalHooks: dispatch.targetSessionKey,
        chatId: String(dispatch.chatId),
        accountId: dispatch.route.accountId,
        content: progressResultText,
        success: true,
        messageId: progressMessageId,
        isGroup: dispatch.isGroup,
        groupId: dispatch.isGroup ? String(dispatch.chatId) : undefined,
      });
      await dispatch.recordDeliveredReply(
        commandBody,
        progressResultText,
        String(progressMessageId),
      );
      return;
    } catch {
      // Fall through to cleanup + normal delivered reply if editing fails.
    }
  }
  await cleanupProgressPlaceholder();
  const delivered = await deliverReplies({
    replies: [deliverableResult],
    ...dispatch.deliveryOptions,
    ...(hasReaction ? { replyToMode: "all" as const } : {}),
    silent:
      dispatch.runtimeTelegramCfg.silentErrorReplies === true && deliverableResult.isError === true,
  });
  if (delivered.delivered && deliverableResult.text) {
    await dispatch.recordDeliveredReply(commandBody, deliverableResult.text, "final");
  }
}
