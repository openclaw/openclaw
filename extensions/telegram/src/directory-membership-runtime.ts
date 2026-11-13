import { AbortController as TelegramAbortController } from "abort-controller";
import { Bot } from "grammy";
import type { ChatMember } from "grammy/types";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { makeProxyFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import {
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  resolveTelegramAccountConfig,
} from "./accounts.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport } from "./fetch.js";
import { parseTelegramTarget } from "./targets.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";

const TELEGRAM_GROUP_MEMBERSHIP_TIMEOUT_MS = 4_000;

type TelegramGroupMembershipParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["directory"]>["isGroupMember"]>
>[0];

function resolveTelegramMembershipStatus(member: ChatMember): boolean | null {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    case "restricted":
      return typeof member.is_member === "boolean" ? member.is_member : null;
    case "left":
    case "kicked":
      return false;
    default:
      return null;
  }
}

/** Resolve one current membership fact for one account, chat, and numeric sender. */
export async function isTelegramGroupMember(
  params: TelegramGroupMembershipParams,
): Promise<boolean | null> {
  const target = parseTelegramTarget(params.groupId);
  const memberId = parseStrictPositiveInteger(params.memberId);
  if (
    target.chatId !== params.groupId ||
    target.chatType !== "group" ||
    target.messageThreadId !== undefined ||
    target.directMessagesTopicId !== undefined ||
    memberId === undefined ||
    String(memberId) !== params.memberId
  ) {
    return null;
  }

  let transport: ReturnType<typeof resolveTelegramTransport> | undefined;
  const deadline = buildTimeoutAbortSignal({
    timeoutMs: TELEGRAM_GROUP_MEMBERSHIP_TIMEOUT_MS,
    signal: params.signal,
    operation: "telegram-group-membership",
  });
  // grammY queues use the abort-controller signal type; keep cancellation through that queue.
  const apiAbort = new TelegramAbortController();
  const abort = () => apiAbort.abort();
  if (deadline.signal?.aborted) {
    abort();
  } else {
    deadline.signal?.addEventListener("abort", abort, { once: true });
  }
  try {
    if (deadline.signal?.aborted) {
      return null;
    }
    const requestedAccountId = params.accountId?.trim()
      ? normalizeAccountId(params.accountId)
      : resolveDefaultTelegramAccountId(params.cfg);
    if (
      requestedAccountId !== resolveDefaultTelegramAccountId(params.cfg) &&
      !resolveTelegramAccountConfig(params.cfg, requestedAccountId)
    ) {
      return null;
    }
    const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
    if (account.accountId !== requestedAccountId || !account.enabled || !account.token) {
      return null;
    }
    const botId = resolveTelegramBotUserIdFromToken(account.token);
    if (botId === undefined) {
      return null;
    }

    const proxyUrl = account.config.proxy?.trim();
    const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
    transport = resolveTelegramTransport(proxyFetch, { network: account.config.network });
    const fetch = createTelegramClientFetch({
      fetchImpl: asTelegramClientFetch(transport.fetch),
      transport,
    });
    const apiRoot = account.config.apiRoot?.trim();
    const bot = new Bot(account.token, {
      client: {
        fetch: asTelegramClientFetch(fetch),
        ...(apiRoot ? { apiRoot: normalizeTelegramApiRoot(apiRoot) } : {}),
      },
    });
    bot.api.config.use(getOrCreateAccountThrottler(account.token).transformer);

    // Non-admin lookups may succeed too; require explicit membership for this bot and user.
    const botMember = await bot.api.getChatMember(target.chatId, botId, apiAbort.signal);
    if (botMember.user.id !== botId || resolveTelegramMembershipStatus(botMember) !== true) {
      return null;
    }
    const member = await bot.api.getChatMember(target.chatId, memberId, apiAbort.signal);
    if (member.user.id !== memberId) {
      return null;
    }
    return resolveTelegramMembershipStatus(member);
  } catch {
    return null;
  } finally {
    deadline.signal?.removeEventListener("abort", abort);
    deadline.cleanup();
    await transport?.close().catch(() => undefined);
  }
}
