import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-core";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringOrNumberParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { inspectTelegramAccount } from "./account-inspect.js";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import {
  isTelegramHistoryNodeAllowed,
  isTelegramHistorySenderAllowed,
  readTelegramHistory,
} from "./history-policy.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramHistoryReadContext = Pick<
  ChannelMessageActionContext,
  | "sessionKey"
  | "toolContext"
  | "requesterAccountId"
  | "requesterSenderId"
  | "assertDirectAdapterHandoff"
>;

const HISTORY_SCOPE_ERROR =
  "Telegram history read requires the authenticated current group session, account, chat, and exact topic.";

function resolveReadScope(
  params: Record<string, unknown>,
  context: TelegramHistoryReadContext | undefined,
) {
  const toolContext = context?.toolContext;
  const accountId = normalizeOptionalAccountId(context?.requesterAccountId);
  const requestedAccount = normalizeOptionalAccountId(readStringOrNumberParam(params, "accountId"));
  const senderId = context?.requesterSenderId?.trim();
  if (
    !context?.sessionKey?.trim() ||
    !accountId ||
    (requestedAccount !== undefined && requestedAccount !== accountId) ||
    !senderId ||
    !/^\d+$/.test(senderId) ||
    toolContext?.currentChannelProvider?.trim().toLowerCase() !== "telegram" ||
    (toolContext.currentChatType !== undefined && toolContext.currentChatType !== "group")
  ) {
    throw new Error(HISTORY_SCOPE_ERROR);
  }
  const currentTargets = [toolContext.currentChannelId, toolContext.currentMessagingTarget]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map(parseTelegramTarget);
  const chatId = currentTargets[0]?.chatId;
  const contextThread = parseStrictPositiveInteger(toolContext.currentThreadTs);
  if (toolContext.currentThreadTs != null && contextThread === undefined) {
    throw new Error(HISTORY_SCOPE_ERROR);
  }
  const threadIds = [
    ...currentTargets.map((target) => target.messageThreadId),
    contextThread,
  ].filter((value): value is number => value !== undefined);
  const threadId = threadIds[0];
  if (
    !chatId ||
    !/^-\d+$/.test(chatId) ||
    currentTargets.some(
      (target) => target.chatId !== chatId || target.directMessagesTopicId !== undefined,
    ) ||
    threadIds.some((id) => id !== threadId || id <= 0)
  ) {
    throw new Error(HISTORY_SCOPE_ERROR);
  }
  for (const key of ["target", "to", "chatId", "channelId"]) {
    const requested = readStringOrNumberParam(params, key);
    if (requested === undefined) {
      continue;
    }
    const target = parseTelegramTarget(requested);
    if (
      target.chatId !== chatId ||
      target.directMessagesTopicId !== undefined ||
      (target.messageThreadId !== undefined && target.messageThreadId !== threadId)
    ) {
      throw new Error(HISTORY_SCOPE_ERROR);
    }
  }
  for (const key of ["threadId", "messageThreadId"]) {
    const requested = readPositiveIntegerParam(params, key);
    if (requested !== undefined && requested !== threadId) {
      throw new Error(HISTORY_SCOPE_ERROR);
    }
  }
  return {
    accountId,
    chatId,
    threadId,
    senderId,
    sessionKey: context.sessionKey,
    currentMessageId: parseStrictPositiveInteger(toolContext.currentMessageId),
  };
}

export async function readTelegramHistoryAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  context?: TelegramHistoryReadContext,
) {
  const assertReadAuthority = captureChannelReadAuthority();
  assertReadAuthority?.();
  context?.assertDirectAdapterHandoff?.();
  const scope = resolveReadScope(params, context);
  const getConfig = createRuntimeConfigReader(cfg);
  const currentConfig = getConfig();
  const currentToolContext = { ...context?.toolContext };
  const requesterAccountId = context?.requesterAccountId;
  const requesterSenderId = context?.requesterSenderId;
  const assertCurrent = () => {
    assertReadAuthority?.();
    context?.assertDirectAdapterHandoff?.();
    const current = context?.toolContext;
    if (
      getConfig() !== currentConfig ||
      context?.requesterAccountId !== requesterAccountId ||
      context?.requesterSenderId !== requesterSenderId ||
      context?.sessionKey !== scope.sessionKey ||
      current?.currentChannelProvider !== currentToolContext.currentChannelProvider ||
      current?.currentChatType !== currentToolContext.currentChatType ||
      current?.currentChannelId !== currentToolContext.currentChannelId ||
      current?.currentMessagingTarget !== currentToolContext.currentMessagingTarget ||
      current?.currentThreadTs !== currentToolContext.currentThreadTs ||
      current?.currentMessageId !== currentToolContext.currentMessageId
    ) {
      throw new Error(HISTORY_SCOPE_ERROR);
    }
  };
  const account = inspectTelegramAccount({ cfg: currentConfig, accountId: scope.accountId });
  if (!account.enabled || !account.configured || account.accountId !== scope.accountId) {
    throw new Error("Telegram history is unavailable for the current account.");
  }
  const policy = {
    cfg: currentConfig,
    accountId: scope.accountId,
    chatId: scope.chatId,
    threadId: scope.threadId,
    botUserId: parseStrictPositiveInteger(account.token.split(":", 1)[0]),
    assertCurrent,
  };
  if (!(await isTelegramHistorySenderAllowed({ ...policy, senderId: scope.senderId }))) {
    throw new Error("Telegram history read is not permitted by the current group policy.");
  }
  assertCurrent();
  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(currentConfig.session?.store, {
        agentId: resolveTelegramAccountOwnerAgentId({
          cfg: currentConfig,
          accountId: scope.accountId,
        }),
      }),
    ),
  });
  const messageId = readPositiveIntegerParam(params, "messageId");
  const before = readPositiveIntegerParam(params, "before");
  const after = readPositiveIntegerParam(params, "after");
  if (params.around != null) {
    throw new Error(
      "Telegram history supports messageId for an exact message, or before/after for paging.",
    );
  }
  if (messageId !== undefined && (before !== undefined || after !== undefined)) {
    throw new Error("Use messageId alone for an exact Telegram history read.");
  }
  const limit = Math.min(readPositiveIntegerParam(params, "limit") ?? 50, 100);
  assertCurrent();
  let result;
  if (messageId !== undefined) {
    const node = await cache.get({ ...scope, messageId: String(messageId) });
    assertCurrent();
    const allowed = node && (await isTelegramHistoryNodeAllowed({ ...policy, node }));
    assertCurrent();
    result = { messages: node && allowed ? [node] : [], hasMore: false };
  } else {
    const anchor = before ?? (after === undefined ? scope.currentMessageId : undefined);
    result = await readTelegramHistory({
      ...policy,
      cache,
      before: anchor === undefined ? undefined : String(anchor),
      after: after === undefined ? undefined : String(after),
      limit,
    });
    assertCurrent();
  }
  if (!(await isTelegramHistorySenderAllowed({ ...policy, senderId: scope.senderId }))) {
    throw new Error("Telegram history read is not permitted by the current group policy.");
  }
  assertCurrent();
  return jsonResult({
    ok: true,
    chatId: scope.chatId,
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
    messages: result.messages.map((node) => ({
      messageId: node.messageId,
      sender: node.sender,
      senderId: node.senderId,
      senderUsername: node.senderUsername,
      timestamp: node.timestamp,
      body: node.body,
      mediaType: node.mediaType,
      mediaRef: node.mediaRef,
      replyToId: node.replyToId,
    })),
    hasMore: result.hasMore,
    oldestMessageId: result.messages[0]?.messageId,
    newestMessageId: result.messages.at(-1)?.messageId,
  });
}
