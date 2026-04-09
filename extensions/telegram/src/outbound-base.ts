import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/outbound-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { sendTelegramPayloadMessages } from "./outbound-adapter.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { getTelegramRuntime } from "./runtime.js";

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendPollFn = typeof import("./send.js").sendPollTelegram;
type TelegramSendTypingFn = typeof import("./send.js").sendTypingTelegram;

type TelegramSendOptions = NonNullable<Parameters<TelegramSendFn>[2]>;

let telegramSendModulePromise: Promise<typeof import("./send.js")> | null = null;

async function loadTelegramSendModule() {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}

function getOptionalTelegramRuntime() {
  try {
    return getTelegramRuntime();
  } catch {
    return null;
  }
}

export function resolveTelegramSend(deps?: OutboundSendDeps): TelegramSendFn {
  return (
    resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
    getOptionalTelegramRuntime()?.channel?.telegram?.sendMessageTelegram ??
    sendMessageTelegramLazy
  );
}

async function sendMessageTelegramLazy(
  ...args: Parameters<TelegramSendFn>
): ReturnType<TelegramSendFn> {
  const { sendMessageTelegram } = await loadTelegramSendModule();
  return await sendMessageTelegram(...args);
}

async function sendPollTelegramLazy(
  ...args: Parameters<TelegramSendPollFn>
): ReturnType<TelegramSendPollFn> {
  const { sendPollTelegram } = await loadTelegramSendModule();
  return await sendPollTelegram(...args);
}

async function sendTypingTelegramLazy(
  ...args: Parameters<TelegramSendTypingFn>
): ReturnType<TelegramSendTypingFn> {
  const { sendTypingTelegram } = await loadTelegramSendModule();
  return await sendTypingTelegram(...args);
}

export function resolveTelegramTokenHelper() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.resolveTelegramToken ??
    ((cfg: OpenClawConfig, params?: { accountId?: string | null }) =>
      import("./token.js").then(({ resolveTelegramToken }) => resolveTelegramToken(cfg, params)))
  );
}

export function buildTelegramSendOptions(params: {
  cfg: OpenClawConfig;
  mediaUrl?: string | null;
  mediaLocalRoots?: readonly string[] | null;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean | null;
  forceDocument?: boolean | null;
  gatewayClientScopes?: readonly string[] | null;
}): TelegramSendOptions {
  return {
    verbose: false,
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    messageThreadId: parseTelegramThreadId(params.threadId),
    replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
    accountId: params.accountId ?? undefined,
    silent: params.silent ?? undefined,
    forceDocument: params.forceDocument ?? undefined,
    ...(Array.isArray(params.gatewayClientScopes)
      ? { gatewayClientScopes: [...params.gatewayClientScopes] }
      : {}),
  };
}

async function sendTelegramOutbound(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl?: string | null;
  mediaLocalRoots?: readonly string[] | null;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean | null;
  gatewayClientScopes?: readonly string[] | null;
}) {
  const send = resolveTelegramSend(params.deps);
  return await send(
    params.to,
    params.text,
    buildTelegramSendOptions({
      cfg: params.cfg,
      mediaUrl: params.mediaUrl,
      mediaLocalRoots: params.mediaLocalRoots,
      accountId: params.accountId,
      replyToId: params.replyToId,
      threadId: params.threadId,
      silent: params.silent,
      gatewayClientScopes: params.gatewayClientScopes,
    }),
  );
}

export const telegramChannelOutbound = {
  base: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) =>
      getTelegramRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown" as const,
    textChunkLimit: 4000,
    pollMaxOptions: 10,
    shouldSuppressLocalPayloadPrompt: ({
      cfg,
      accountId,
      payload,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      payload: ReplyPayload;
    }) =>
      shouldSuppressLocalTelegramExecApprovalPrompt({
        cfg,
        accountId,
        payload,
      }),
    beforeDeliverPayload: async ({
      cfg,
      target,
      hint,
    }: {
      cfg: OpenClawConfig;
      target: { to: string; accountId?: string | null; threadId?: string | number | null };
      hint?: { kind?: string; approvalKind?: string } | null;
    }) => {
      if (hint?.kind !== "approval-pending" || hint.approvalKind !== "exec") {
        return;
      }
      const threadId =
        typeof target.threadId === "number"
          ? target.threadId
          : typeof target.threadId === "string"
            ? Number.parseInt(target.threadId, 10)
            : undefined;
      await sendTypingTelegramLazy(target.to, {
        cfg,
        accountId: target.accountId ?? undefined,
        ...(Number.isFinite(threadId) ? { messageThreadId: threadId } : {}),
      }).catch(() => {});
    },
    shouldSkipPlainTextSanitization: ({ payload }: { payload: { channelData?: unknown } }) =>
      Boolean(payload.channelData),
    resolveEffectiveTextChunkLimit: ({ fallbackLimit }: { fallbackLimit?: number | null }) =>
      typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
    sendPayload: async ({
      cfg,
      to,
      payload,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      silent,
      forceDocument,
      gatewayClientScopes,
    }: {
      cfg: OpenClawConfig;
      to: string;
      payload: ReplyPayload;
      mediaLocalRoots?: readonly string[] | null;
      accountId?: string | null;
      deps?: OutboundSendDeps;
      replyToId?: string | null;
      threadId?: string | number | null;
      silent?: boolean | null;
      forceDocument?: boolean | null;
      gatewayClientScopes?: readonly string[] | null;
    }) => {
      const send = resolveTelegramSend(deps);
      const result = await sendTelegramPayloadMessages({
        send,
        to,
        payload,
        baseOpts: buildTelegramSendOptions({
          cfg,
          mediaLocalRoots,
          accountId,
          replyToId,
          threadId,
          silent,
          forceDocument,
          gatewayClientScopes,
        }),
      });
      return attachChannelToResult("telegram", result);
    },
  },
  attachedResults: {
    channel: "telegram" as const,
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      silent,
      gatewayClientScopes,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
      deps?: OutboundSendDeps;
      replyToId?: string | null;
      threadId?: string | number | null;
      silent?: boolean | null;
      gatewayClientScopes?: readonly string[] | null;
    }) =>
      await sendTelegramOutbound({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
        gatewayClientScopes,
      }),
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      silent,
      gatewayClientScopes,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      mediaUrl?: string | null;
      mediaLocalRoots?: readonly string[] | null;
      accountId?: string | null;
      deps?: OutboundSendDeps;
      replyToId?: string | null;
      threadId?: string | number | null;
      silent?: boolean | null;
      gatewayClientScopes?: readonly string[] | null;
    }) =>
      await sendTelegramOutbound({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
        gatewayClientScopes,
      }),
    sendPoll: async ({
      cfg,
      to,
      poll,
      accountId,
      threadId,
      silent,
      isAnonymous,
      gatewayClientScopes,
    }: {
      cfg: OpenClawConfig;
      to: string;
      poll: Parameters<TelegramSendPollFn>[1];
      accountId?: string | null;
      threadId?: string | number | null;
      silent?: boolean | null;
      isAnonymous?: boolean | null;
      gatewayClientScopes?: readonly string[] | null;
    }) =>
      await sendPollTelegramLazy(to, poll, {
        cfg,
        accountId: accountId ?? undefined,
        messageThreadId: parseTelegramThreadId(threadId),
        silent: silent ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
        gatewayClientScopes: gatewayClientScopes ?? undefined,
      }),
  },
};
