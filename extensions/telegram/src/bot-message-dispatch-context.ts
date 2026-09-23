// Telegram plugin module recovers dispatch routing and group-history context.
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramInboundOriginTarget,
  buildTypingThreadParams,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import {
  isTelegramChatWindowPromptContext,
  selectTelegramGroupPromptContext,
  telegramPromptContextHistory,
} from "./group-history-window.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

function normalizeTelegramThreadId(value: unknown): number | undefined {
  return parseStrictPositiveInteger(value);
}

function resolveTelegramForumThreadScopeFromSessionKey(
  sessionKey: unknown,
): { chatId: string; threadId: number } | undefined {
  if (typeof sessionKey !== "string") {
    return undefined;
  }
  const match = /:telegram:group:(-?\d+):topic:(\d+)(?::|$)/.exec(sessionKey);
  const threadId = normalizeTelegramThreadId(match?.[2]);
  if (!match?.[1] || threadId == null) {
    return undefined;
  }
  return { chatId: match[1], threadId };
}

function resolveDispatchTelegramThreadSpec(params: {
  chatId: TelegramMessageContext["chatId"];
  ctxPayload: TelegramMessageContext["ctxPayload"];
  threadSpec: TelegramThreadSpec;
}): TelegramThreadSpec {
  if (
    params.threadSpec.scope !== "forum" ||
    (params.threadSpec.id != null && params.threadSpec.id !== TELEGRAM_GENERAL_TOPIC_ID)
  ) {
    return params.threadSpec;
  }
  const scopedThread = resolveTelegramForumThreadScopeFromSessionKey(params.ctxPayload.SessionKey);
  const scopedThreadId =
    scopedThread?.chatId === String(params.chatId) ? scopedThread.threadId : undefined;
  const payloadThreadId =
    normalizeTelegramThreadId(params.ctxPayload.MessageThreadId) ??
    normalizeTelegramThreadId(params.ctxPayload.TransportThreadId);
  // Missing forum IDs are normalized to General; topic-scoped turn facts are more specific.
  const recoveredThreadId = scopedThreadId ?? payloadThreadId;
  return recoveredThreadId == null || recoveredThreadId === params.threadSpec.id
    ? params.threadSpec
    : { ...params.threadSpec, id: recoveredThreadId };
}

function normalizeDispatchTelegramThreadPayload(params: {
  context: TelegramMessageContext;
  threadSpec: TelegramThreadSpec;
}): TelegramMessageContext {
  if (params.threadSpec.scope !== "forum" || params.threadSpec.id == null) {
    return params.context;
  }
  const messageThreadId = normalizeTelegramThreadId(params.context.ctxPayload.MessageThreadId);
  const transportThreadId = normalizeTelegramThreadId(params.context.ctxPayload.TransportThreadId);
  if (messageThreadId === params.threadSpec.id && transportThreadId === params.threadSpec.id) {
    return params.context;
  }
  // This payload owns private host admission state outside its enumerable fields.
  // Normalize routing in place so a plugin-visible copier is never needed.
  Object.assign(params.context.ctxPayload, {
    MessageThreadId: params.threadSpec.id,
    TransportThreadId: params.threadSpec.id,
  });
  return params.context;
}

function buildRecoveredTelegramChatActionSender(params: {
  context: TelegramMessageContext;
  threadId?: number;
  action: "typing" | "record_voice";
}): () => Promise<void> {
  return async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          params.context.sendChatActionHandler.sendChatAction(
            params.context.chatId,
            params.action,
            buildTypingThreadParams(params.threadId),
          ),
      });
    } catch (err) {
      if (params.action !== "record_voice") {
        throw err;
      }
      logVerbose(
        `telegram record_voice cue failed for chat ${params.context.chatId}: ${String(err)}`,
      );
    }
  };
}

export async function resolveDispatchTelegramContext(params: {
  context: TelegramMessageContext;
}): Promise<TelegramMessageContext> {
  const threadSpec = resolveDispatchTelegramThreadSpec({
    chatId: params.context.chatId,
    ctxPayload: params.context.ctxPayload,
    threadSpec: params.context.threadSpec,
  });
  if (threadSpec === params.context.threadSpec || threadSpec.scope !== "forum") {
    return normalizeDispatchTelegramThreadPayload({ context: params.context, threadSpec });
  }
  const recoveredRoutingTarget = buildTelegramInboundOriginTarget(
    params.context.chatId,
    threadSpec,
  );
  const recoveredFrom = params.context.isGroup
    ? buildTelegramGroupFrom(params.context.chatId, threadSpec)
    : params.context.ctxPayload.From;
  const recoveredUpdateLastRoute =
    params.context.turn.record.updateLastRoute && threadSpec.id != null
      ? {
          ...params.context.turn.record.updateLastRoute,
          to: `telegram:${params.context.chatId}:topic:${threadSpec.id}`,
          threadId: String(threadSpec.id),
        }
      : params.context.turn.record.updateLastRoute;
  const recoveredHistoryKey = params.context.isGroup
    ? buildTelegramGroupPeerId(params.context.chatId, threadSpec)
    : params.context.historyKey;
  const promptContext = params.context.ctxPayload.ChannelStructuredContext ?? [];
  let recoveredPromptContext =
    params.context.historyLimit > 0
      ? promptContext.filter((entry) => !isTelegramChatWindowPromptContext(entry))
      : selectTelegramGroupPromptContext({
          promptContext,
          historyLimit: 0,
          includeBeforeSelf: false,
        });
  if (params.context.isGroup && params.context.historyLimit > 0) {
    const telegramCfg = resolveTelegramAccount({
      cfg: params.context.cfg,
      accountId: params.context.accountId,
    }).config;
    const runtime = createTelegramMessageContextRuntime({
      cfg: params.context.cfg,
      accountId: params.context.accountId,
      ownerAgentId: resolveTelegramAccountOwnerAgentId({
        cfg: params.context.cfg,
        accountId: params.context.accountId,
      }),
      telegramCfg,
      opts: { botInfo: params.context.primaryCtx.me },
      telegramDeps: { resolveStorePath },
    });
    const ambientWatermark = params.context.ctxPayload.AmbientTranscriptPreviousMessageId
      ? {
          messageId: params.context.ctxPayload.AmbientTranscriptPreviousMessageId,
          timestampMs: params.context.ctxPayload.AmbientTranscriptPreviousTimestampMs,
        }
      : undefined;
    const replyChain = await runtime.buildReplyChainForMessage(params.context.msg);
    recoveredPromptContext = selectTelegramGroupPromptContext({
      promptContext: [
        ...recoveredPromptContext,
        ...(await runtime.buildPromptContextForMessage(
          params.context.primaryCtx,
          params.context.msg,
          replyChain,
          params.context.cfg,
          { ...telegramCfg, historyLimit: params.context.historyLimit },
          {
            threadSpec,
            promptContextMinTimestampMs:
              params.context.ctxPayload.SessionTranscriptContext?.minTimestampMs,
            promptContextAmbientWatermark: ambientWatermark,
          },
        )),
      ],
      historyLimit: params.context.historyLimit,
      ambientWatermark,
      includeBeforeSelf: params.context.ctxPayload.InboundEventKind === "room_event",
    });
  }
  const recoveredHistory = telegramPromptContextHistory(recoveredPromptContext);
  const recoveredInboundHistory = recoveredHistory.length > 0 ? recoveredHistory : undefined;
  const recoveredSendTyping = buildRecoveredTelegramChatActionSender({
    context: params.context,
    threadId: threadSpec.id,
    action: "typing",
  });
  const recoveredSendRecordVoice = buildRecoveredTelegramChatActionSender({
    context: params.context,
    threadId: threadSpec.id,
    action: "record_voice",
  });
  if (threadSpec.id != null) {
    // Keep the admitted payload object intact; replacing it would discard the
    // host-only participant carrier before canonical run admission.
    Object.assign(params.context.ctxPayload, {
      From: recoveredFrom,
      InboundHistory: recoveredInboundHistory,
      MessageThreadId: threadSpec.id,
      OriginatingTo: recoveredRoutingTarget,
      To: recoveredRoutingTarget,
      TransportThreadId: threadSpec.id,
      ChannelStructuredContext:
        recoveredPromptContext.length > 0 ? recoveredPromptContext : undefined,
    });
  }
  const recovered = {
    ...params.context,
    historyKey: recoveredHistoryKey,
    threadSpec,
    resolvedThreadId: threadSpec.id,
    replyThreadId: threadSpec.id,
    sendTyping: recoveredSendTyping,
    sendRecordVoice: recoveredSendRecordVoice,
    turn: {
      ...params.context.turn,
      record: {
        ...params.context.turn.record,
        updateLastRoute: recoveredUpdateLastRoute,
      },
    },
    ctxPayload: params.context.ctxPayload,
  };
  return recovered;
}
