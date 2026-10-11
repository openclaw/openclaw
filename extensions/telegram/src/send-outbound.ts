import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import {
  recordOutboundMessageForPromptContext,
  type TelegramOutboundPromptContextMessage,
} from "./outbound-message-context.js";
import {
  assertTelegramProviderThread,
  resolveTelegramProviderObservedThreadId,
} from "./provider-thread-proof.js";
import {
  buildTelegramThreadReplyParams,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";
import {
  createRequestWithChatNotFound,
  createTelegramNonIdempotentRequestWithDiag,
  createTelegramRequestWithDiag,
  normalizeMessageId,
  resolveAndPersistChatId,
  resolveTelegramMessageIdOrThrow,
  withTelegramApiContext,
  type TelegramApiContext,
} from "./send-context.js";
import type {
  TelegramMessageActionOpts,
  TelegramSendOpts,
  TelegramSendResult,
} from "./send-message-types.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget } from "./targets.js";

type PreparedTelegramOutbound = {
  chatId: string;
  threadSpec?: ReturnType<typeof resolveTelegramSendThreadSpec>;
  threadParams: ReturnType<typeof buildTelegramThreadReplyParams>;
  request: ReturnType<typeof createTelegramRequestWithDiag>;
};

type TelegramMessageActionContext<T> = TelegramApiContext & {
  chatId: string;
  request: ReturnType<typeof createTelegramRequestWithDiag>;
} & (T extends string | number ? { messageId: number } : { messageId?: undefined });

export function withTelegramMessageAction<T, TMessageId extends string | number | undefined>(
  to: string | number,
  messageIdInput: TMessageId,
  opts: TelegramMessageActionOpts,
  operation: (context: TelegramMessageActionContext<TMessageId>) => Promise<T>,
  shouldRetry?: (error: unknown) => boolean,
  writebackAuthority: "caller" | "internal" = "caller",
): Promise<T> {
  return withTelegramApiContext(opts, async (context) => {
    const { cfg } = context;
    const rawTarget = String(to);
    const chatId = await resolveAndPersistChatId(context, {
      lookupTarget: parseTelegramTarget(rawTarget).chatId,
      persistTarget: rawTarget,
      verbose: opts.verbose,
      gatewayClientScopes: writebackAuthority === "internal" ? undefined : opts.gatewayClientScopes,
    });
    const request = createTelegramRequestWithDiag({
      cfg,
      retry: opts.retry,
      verbose: opts.verbose,
      shouldRetry,
    });
    return operation({
      ...context,
      chatId,
      ...(messageIdInput !== undefined ? { messageId: normalizeMessageId(messageIdInput) } : {}),
      request,
    } as TelegramMessageActionContext<TMessageId>);
  });
}

export function buildTelegramProviderDeliveryResult(params: {
  message: TelegramOutboundPromptContextMessage;
  messageId: string | number;
  fallbackChatId: string | number;
  successfulSendThread?: TelegramThreadSpec;
  kind?: MessageReceiptPartKind;
  meta?: TelegramSendResult["meta"];
}): TelegramSendResult {
  const messageId = String(params.messageId);
  const chatId = String(params.message.chat?.id ?? params.fallbackChatId);
  const providerThreadId = resolveTelegramProviderObservedThreadId({
    message: params.message,
    successfulSendThread: params.successfulSendThread,
  });
  return {
    messageId,
    chatId,
    ...(providerThreadId !== undefined
      ? {
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ messageId, chatId }],
            ...(params.kind !== undefined ? { kind: params.kind } : {}),
            threadId: String(providerThreadId),
          }),
        }
      : {}),
    ...(params.meta ? { meta: params.meta } : {}),
  };
}

export async function reportTelegramProviderDelivery(
  params: Parameters<typeof buildTelegramProviderDeliveryResult>[0] & {
    onPrepared?: (delivery: TelegramSendResult) => void;
    onDeliveryResult?: TelegramSendOpts["onDeliveryResult"];
  },
): Promise<TelegramSendResult> {
  const delivery = buildTelegramProviderDeliveryResult(params);
  params.onPrepared?.(delivery);
  await params.onDeliveryResult?.(delivery);
  try {
    assertTelegramProviderThread({
      message: params.message,
      successfulSendThread: params.successfulSendThread,
    });
  } catch (error) {
    throw createChannelPartialDeliveryError(error, {
      messageIds: [delivery.messageId],
      ...(delivery.receipt ? { receipt: delivery.receipt } : {}),
      visibleReplySent: true,
    });
  }
  return delivery;
}

export async function prepareTelegramOutbound(params: {
  to: string | number;
  context: TelegramApiContext;
  opts: Pick<TelegramSendOpts, "verbose" | "retry" | "gatewayClientScopes">;
  thread?: {
    messageThreadId?: number;
    directMessagesTopicId?: number;
    replyToMessageId?: number;
    replyQuoteText?: string;
    useReplyIdAsQuoteSource?: boolean;
  };
  useApiErrorLogging?: boolean;
  wrapChatNotFound?: boolean;
}): Promise<PreparedTelegramOutbound> {
  const { cfg } = params.context;
  const rawTarget = String(params.to);
  const target = parseTelegramTarget(rawTarget);
  const threadSpec = params.thread
    ? resolveTelegramSendThreadSpec({
        targetMessageThreadId: target.messageThreadId,
        targetDirectMessagesTopicId:
          params.thread.directMessagesTopicId ?? target.directMessagesTopicId,
        messageThreadId: params.thread.messageThreadId,
        chatType: target.chatType,
      })
    : undefined;
  const chatId = await resolveAndPersistChatId(params.context, {
    lookupTarget: target.chatId,
    persistTarget: rawTarget,
    verbose: params.opts.verbose,
    gatewayClientScopes: params.opts.gatewayClientScopes,
  });
  const threadParams = buildTelegramThreadReplyParams({
    thread: threadSpec,
    replyToMessageId: params.thread?.replyToMessageId,
    replyQuoteText: params.thread?.replyQuoteText,
    useReplyIdAsQuoteSource: params.thread?.useReplyIdAsQuoteSource,
  });
  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    retry: params.opts.retry,
    verbose: params.opts.verbose,
    useApiErrorLogging: params.useApiErrorLogging,
  });
  return {
    chatId,
    threadSpec,
    threadParams,
    request:
      params.wrapChatNotFound === false
        ? requestWithDiag
        : createRequestWithChatNotFound({ requestWithDiag, chatId, input: rawTarget }),
  };
}

export async function finalizeTelegramOutbound(params: {
  context: TelegramApiContext;
  prepared: Pick<PreparedTelegramOutbound, "chatId" | "threadSpec">;
  result: Parameters<typeof recordOutboundMessageForPromptContext>[0]["message"];
  resultContext: string;
  botUserId?: number;
  text?: string;
  messageThreadId?: number;
  promptContextProjectionPlan?: TelegramSendOpts["promptContextProjectionPlan"];
  onDeliveryResult?: TelegramSendOpts["onDeliveryResult"];
  beforeActivity?: (result: { messageId: string; chatId: string }) => void;
}): Promise<TelegramSendResult> {
  const { cfg, account, ownerAgentId } = params.context;
  const messageId = resolveTelegramMessageIdOrThrow(params.result, params.resultContext);
  await recordSentMessage(params.prepared.chatId, messageId, cfg, {
    accountId: account.accountId,
    agentId: ownerAgentId,
  });
  const resultIds = await reportTelegramProviderDelivery({
    message: params.result,
    messageId,
    fallbackChatId: params.prepared.chatId,
    successfulSendThread: params.prepared.threadSpec,
    onDeliveryResult: params.onDeliveryResult,
  });
  const projection = params.promptContextProjectionPlan?.cursor.take(
    params.promptContextProjectionPlan.finalPart,
  );
  try {
    const recorded = await recordOutboundMessageForPromptContext({
      cfg,
      ownerAgentId,
      account,
      botUserId: params.botUserId,
      chatId: params.prepared.chatId,
      message: params.result,
      messageId,
      text: params.text,
      messageThreadId: params.messageThreadId ?? params.prepared.threadSpec?.id,
      successfulSendThread: params.prepared.threadSpec,
      promptContextProjection: projection,
    });
    if (projection && !recorded) {
      params.promptContextProjectionPlan?.cursor.invalidate();
    }
  } catch (error) {
    params.promptContextProjectionPlan?.cursor.invalidate();
    throw createChannelPartialDeliveryError(error, {
      messageIds: [resultIds.messageId],
      ...(resultIds.receipt ? { receipt: resultIds.receipt } : {}),
      visibleReplySent: true,
    });
  }
  params.beforeActivity?.(resultIds);
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return resultIds;
}
