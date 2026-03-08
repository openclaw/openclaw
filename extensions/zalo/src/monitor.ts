import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createTypingCallbacks,
  createScopedPairingAccess,
  createReplyPrefixOptions,
  logTypingFailure,
  resolveSenderCommandAuthorizationWithRuntime,
  resolveOutboundMediaUrls,
  sendMediaWithLeadingCaption,
  resolveWebhookPath,
} from "openclaw/plugin-sdk/zalo";
import type {
  MarkdownTableMode,
  OpenClawConfig,
  OutboundReplyPayload,
} from "openclaw/plugin-sdk/zalo";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/zalo";
import type { ResolvedZaloAccount } from "./accounts.js";
import {
  ZaloApiAbortError,
  ZaloApiError,
  deleteWebhook,
  getWebhookInfo,
  getUpdates,
  sendChatAction,
  sendMessage,
  sendPhoto,
  setWebhook,
  type ZaloFetch,
  type ZaloMessage,
  type ZaloUpdate,
} from "./api.js";
import { isZaloSenderAllowed } from "./group-access.js";
import {
  describeInboundImagePayload,
  formatUpdateForLog,
  resolveInboundImageUrl,
  resolveInboundStickerUrl,
  resolveInboundText,
  summarizeUnsupportedInbound,
} from "./inbound-parsing.js";
import {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
  handleZaloWebhookRequest as handleZaloWebhookRequestInternal,
  registerZaloWebhookTarget as registerZaloWebhookTargetInternal,
  type ZaloWebhookTarget,
} from "./monitor.webhook.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import { getZaloRuntime } from "./runtime.js";

export type ZaloRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type ZaloMonitorOptions = {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  abortSignal: AbortSignal;
  useWebhook?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  fetcher?: ZaloFetch;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type ZaloMonitorResult = {
  stop: () => void;
};

const ZALO_TEXT_LIMIT = 2000;
const DEFAULT_MEDIA_MAX_MB = 5;
const ZALO_TYPING_TIMEOUT_MS = 5_000;
const WEBHOOK_CLEANUP_TIMEOUT_MS = 5_000;
const SEND_RETRY_DELAYS_MS = [500, 1500] as const;
const RETRYABLE_ZALO_API_ERROR_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const STICKER_REPLY_EMOJI_FALLBACK = "🙂";
const STICKER_REPLY_EMOJI_LIMIT = 3;

type ZaloCoreRuntime = ReturnType<typeof getZaloRuntime>;
type SendRetryControl = {
  abortSignal?: AbortSignal;
  isStopped?: () => boolean;
};

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function formatZaloError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function describeWebhookTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl;
  }
}

function normalizeWebhookUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function logVerbose(core: ZaloCoreRuntime, runtime: ZaloRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[zalo] ${message}`);
  }
}

function isSendRetryCancelled(control?: SendRetryControl): boolean {
  return Boolean(control?.abortSignal?.aborted || control?.isStopped?.());
}

function createSendRetryAbortError(actionLabel: string): ZaloApiAbortError {
  return new ZaloApiAbortError(`${actionLabel} aborted`, "aborted");
}

function waitForRetryDelay(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<"elapsed" | "aborted"> {
  if (!abortSignal) {
    return new Promise<"elapsed">((resolve) => {
      setTimeout(() => resolve("elapsed"), delayMs);
    });
  }
  if (abortSignal.aborted) {
    return Promise.resolve("aborted");
  }
  return new Promise<"elapsed" | "aborted">((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, delayMs);
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function isRetryableSendError(error: unknown): boolean {
  if (error instanceof ZaloApiAbortError) {
    return error.isTimeout;
  }
  if (error instanceof ZaloApiError) {
    return (
      typeof error.errorCode === "number" && RETRYABLE_ZALO_API_ERROR_CODES.has(error.errorCode)
    );
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("fetch failed") ||
      message.includes("networkerror") ||
      message.includes("econnreset") ||
      message.includes("etimedout")
    );
  }
  return false;
}

function toEmojiOnlyReplyText(text: string): string {
  const emojiMatches =
    text.match(
      /(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)|(?:[\u{1F1E6}-\u{1F1FF}]{2})/gu,
    ) ?? [];
  if (emojiMatches.length === 0) {
    return STICKER_REPLY_EMOJI_FALLBACK;
  }
  return emojiMatches.slice(0, STICKER_REPLY_EMOJI_LIMIT).join(" ");
}

async function runWithSendRetry<T>(params: {
  runtime: ZaloRuntimeEnv;
  accountId: string;
  actionLabel: string;
  operation: () => Promise<T>;
  sendRetryControl?: SendRetryControl;
}): Promise<T> {
  const { runtime, accountId, actionLabel, operation, sendRetryControl } = params;
  for (let attempt = 0; ; attempt++) {
    if (isSendRetryCancelled(sendRetryControl)) {
      throw createSendRetryAbortError(actionLabel);
    }
    try {
      return await operation();
    } catch (error) {
      if (isSendRetryCancelled(sendRetryControl)) {
        throw createSendRetryAbortError(actionLabel);
      }
      if (attempt >= SEND_RETRY_DELAYS_MS.length || !isRetryableSendError(error)) {
        throw error;
      }
      const delayMs = SEND_RETRY_DELAYS_MS[attempt];
      runtime.log?.(
        `[${accountId}] [zalo] ${actionLabel} failed (attempt ${attempt + 1}/${
          SEND_RETRY_DELAYS_MS.length + 1
        }): ${String(error)}; retrying in ${delayMs}ms`,
      );
      const waitResult = await waitForRetryDelay(delayMs, sendRetryControl?.abortSignal);
      if (waitResult === "aborted" || isSendRetryCancelled(sendRetryControl)) {
        throw createSendRetryAbortError(actionLabel);
      }
    }
  }
}

export function registerZaloWebhookTarget(target: ZaloWebhookTarget): () => void {
  return registerZaloWebhookTargetInternal(target, {
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "zalo",
      source: "zalo-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleZaloWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  });
}

export {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
};

export async function handleZaloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return handleZaloWebhookRequestInternal(req, res, async ({ update, target }) => {
    await processUpdate(
      update,
      target.token,
      target.account,
      target.config,
      target.runtime,
      target.core as ZaloCoreRuntime,
      target.mediaMaxMb,
      target.statusSink,
      target.fetcher,
      {
        abortSignal: target.abortSignal,
        isStopped: target.isStopped,
      },
    );
  });
}

function startPollingLoop(params: {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  abortSignal: AbortSignal;
  isStopped: () => boolean;
  mediaMaxMb: number;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
}) {
  const {
    token,
    account,
    config,
    runtime,
    core,
    abortSignal,
    isStopped,
    mediaMaxMb,
    statusSink,
    fetcher,
  } = params;
  const pollTimeout = 30;

  runtime.log?.(`[${account.accountId}] Zalo polling loop started timeout=${String(pollTimeout)}s`);

  const poll = async () => {
    if (isStopped() || abortSignal.aborted) {
      return;
    }

    try {
      const response = await getUpdates(
        token,
        { timeout: pollTimeout, timeoutBufferMs: 20_000, abortSignal },
        fetcher,
      );
      if (response.ok && response.result) {
        statusSink?.({ lastInboundAt: Date.now() });
        await processUpdate(
          response.result,
          token,
          account,
          config,
          runtime,
          core,
          mediaMaxMb,
          statusSink,
          fetcher,
          { abortSignal, isStopped },
        );
      }
    } catch (err) {
      if (err instanceof ZaloApiError && err.isPollingTimeout) {
        // no updates
      } else if (err instanceof ZaloApiAbortError && err.isTimeout) {
        logVerbose(
          core,
          runtime,
          `[${account.accountId}] Zalo polling request timed out locally; continuing`,
        );
      } else if (
        err instanceof ZaloApiAbortError ||
        abortSignal.aborted ||
        isStopped() ||
        isAbortError(err)
      ) {
        // expected cancellation path
      } else if (err instanceof ZaloApiError) {
        runtime.error?.(`[${account.accountId}] Zalo polling API error: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } else if (!isStopped() && !abortSignal.aborted) {
        runtime.error?.(`[${account.accountId}] Zalo polling error: ${formatZaloError(err)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    if (!isStopped() && !abortSignal.aborted) {
      setImmediate(poll);
    }
  };

  void poll();
}

async function processUpdate(
  update: ZaloUpdate,
  token: string,
  account: ResolvedZaloAccount,
  config: OpenClawConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  mediaMaxMb: number,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
  sendRetryControl?: SendRetryControl,
): Promise<void> {
  const { event_name, message } = update;
  if (!message) {
    if (event_name.toLowerCase().includes("reaction")) {
      runtime.log?.(
        `[${account.accountId}] [zalo] Reaction event payload: ${formatUpdateForLog(update)}`,
      );
      return;
    }
    runtime.log?.(
      `[${account.accountId}] [zalo] Received event without message payload: ${formatUpdateForLog(
        update,
      )}`,
    );
    return;
  }

  switch (event_name) {
    case "message.text.received":
      await handleTextMessage(
        message,
        token,
        account,
        config,
        runtime,
        core,
        statusSink,
        fetcher,
        sendRetryControl,
      );
      break;
    case "message.image.received":
      await handleImageMessage(
        update,
        message,
        token,
        account,
        config,
        runtime,
        core,
        mediaMaxMb,
        statusSink,
        fetcher,
        sendRetryControl,
      );
      break;
    case "message.link.received":
      await handleTextMessage(
        message,
        token,
        account,
        config,
        runtime,
        core,
        statusSink,
        fetcher,
        sendRetryControl,
      );
      break;
    case "message.sticker.received":
      await handleStickerMessage(
        update,
        message,
        token,
        account,
        config,
        runtime,
        core,
        mediaMaxMb,
        statusSink,
        fetcher,
        sendRetryControl,
      );
      break;
    case "message.reaction.received":
      runtime.log?.(
        `[${account.accountId}] [zalo] Reaction event payload: ${formatUpdateForLog(update)}`,
      );
      break;
    case "message.unsupported.received":
      await handleUnsupportedMessage(
        update,
        message,
        token,
        account,
        config,
        runtime,
        core,
        statusSink,
        fetcher,
        sendRetryControl,
      );
      break;
    default:
      runtime.log?.(
        `[${account.accountId}] [zalo] Unhandled event ${event_name}: ${formatUpdateForLog(update)}`,
      );
      break;
  }
}

function buildUnsupportedMessageNotice(
  _summary: ReturnType<typeof summarizeUnsupportedInbound>,
): string {
  return [
    "Sorry, this message type is not supported by Zalo Bot yet.",
    "Please send it as plain text or an image.",
  ].join("\n");
}

async function enforceInboundDirectAccess(params: {
  message: ZaloMessage;
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  rawBody: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
  sendRetryControl?: SendRetryControl;
}): Promise<{
  allowed: boolean;
  isGroup: boolean;
  chatId: string;
  senderId: string;
  senderName?: string;
  commandAuthorized: boolean | undefined;
}> {
  const {
    message,
    token,
    account,
    config,
    runtime,
    core,
    rawBody,
    statusSink,
    fetcher,
    sendRetryControl,
  } = params;
  const pairing = createScopedPairingAccess({
    core,
    channel: "zalo",
    accountId: account.accountId,
  });
  const { from, chat } = message;
  const isGroup = chat.chat_type === "GROUP";
  const chatId = chat.id;
  const senderId = from.id;
  const senderName = from.name ?? from.display_name;

  if (isGroup) {
    logVerbose(core, runtime, `zalo: drop group ${chatId} (direct-only channel)`);
    return {
      allowed: false,
      isGroup,
      chatId,
      senderId,
      senderName,
      commandAuthorized: undefined,
    };
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  if (dmPolicy === "disabled") {
    logVerbose(core, runtime, `Blocked zalo DM from ${senderId} (dmPolicy=disabled)`);
    return {
      allowed: false,
      isGroup,
      chatId,
      senderId,
      senderName,
      commandAuthorized: undefined,
    };
  }

  if (dmPolicy === "open") {
    return {
      allowed: true,
      isGroup,
      chatId,
      senderId,
      senderName,
      commandAuthorized: undefined,
    };
  }

  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));

  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: config,
      rawBody,
      isGroup,
      dmPolicy,
      configuredAllowFrom: configAllowFrom,
      senderId,
      isSenderAllowed: isZaloSenderAllowed,
      readAllowFromStore: pairing.readAllowFromStore,
      runtime: core.channel.commands,
    });

  if (!senderAllowedForCommands) {
    if (dmPolicy === "pairing") {
      const { code, created } = await pairing.upsertPairingRequest({
        id: senderId,
        meta: { name: senderName ?? undefined },
      });

      if (created) {
        logVerbose(core, runtime, `zalo pairing request sender=${senderId}`);
        try {
          await runWithSendRetry({
            runtime,
            accountId: account.accountId,
            actionLabel: "send pairing reply",
            operation: () =>
              sendMessage(
                token,
                {
                  chat_id: chatId,
                  text: core.channel.pairing.buildPairingReply({
                    channel: "zalo",
                    idLine: `Your Zalo user id: ${senderId}`,
                    code,
                  }),
                },
                fetcher,
              ),
            sendRetryControl,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        } catch (err) {
          logVerbose(core, runtime, `zalo pairing reply failed for ${senderId}: ${String(err)}`);
        }
      }
    } else {
      logVerbose(
        core,
        runtime,
        `Blocked unauthorized zalo sender ${senderId} (dmPolicy=${dmPolicy})`,
      );
    }
    return {
      allowed: false,
      isGroup,
      chatId,
      senderId,
      senderName,
      commandAuthorized,
    };
  }

  return {
    allowed: true,
    isGroup,
    chatId,
    senderId,
    senderName,
    commandAuthorized,
  };
}

async function handleUnsupportedMessage(
  update: ZaloUpdate,
  message: ZaloMessage,
  token: string,
  account: ResolvedZaloAccount,
  config: OpenClawConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
  sendRetryControl?: SendRetryControl,
): Promise<void> {
  runtime.log?.(
    `[${account.accountId}] [zalo] Unsupported event payload: ${formatUpdateForLog(update)}`,
  );
  const access = await enforceInboundDirectAccess({
    message,
    token,
    account,
    config,
    runtime,
    core,
    rawBody: `<unsupported:${update.event_name}>`,
    statusSink,
    fetcher,
    sendRetryControl,
  });
  if (!access.allowed) {
    return;
  }

  const summary = summarizeUnsupportedInbound(message);
  try {
    await runWithSendRetry({
      runtime,
      accountId: account.accountId,
      actionLabel: "send unsupported-message notice",
      operation: () =>
        sendMessage(
          token,
          {
            chat_id: message.chat.id,
            text: buildUnsupportedMessageNotice(summary),
          },
          fetcher,
        ),
      sendRetryControl,
    });
    statusSink?.({ lastOutboundAt: Date.now() });
  } catch (error) {
    runtime.error?.(
      `[${account.accountId}] Failed to send unsupported-message notice: ${String(error)}`,
    );
  }
}

async function handleTextMessage(
  message: ZaloMessage,
  token: string,
  account: ResolvedZaloAccount,
  config: OpenClawConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
  sendRetryControl?: SendRetryControl,
): Promise<void> {
  const text = resolveInboundText(message);
  if (!text) {
    return;
  }

  await processMessageWithPipeline({
    message,
    token,
    account,
    config,
    runtime,
    core,
    text,
    mediaPath: undefined,
    mediaType: undefined,
    statusSink,
    fetcher,
    sendRetryControl,
  });
}

async function handleImageMessage(
  update: ZaloUpdate,
  message: ZaloMessage,
  token: string,
  account: ResolvedZaloAccount,
  config: OpenClawConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  mediaMaxMb: number,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
  sendRetryControl?: SendRetryControl,
): Promise<void> {
  const { caption } = message;
  runtime.log?.(
    `[${account.accountId}] [zalo] image event message_id=${message.message_id} ${describeInboundImagePayload(
      message,
    )}`,
  );

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  const resolvedInboundImage = resolveInboundImageUrl(message);

  if (resolvedInboundImage?.url) {
    try {
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: resolvedInboundImage.url,
        maxBytes,
      });
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
    } catch (err) {
      runtime.error?.(`[${account.accountId}] Failed to download Zalo image: ${String(err)}`);
    }
  } else {
    runtime.log?.(
      `[${account.accountId}] [zalo] image event has no downloadable URL: ${describeInboundImagePayload(
        message,
      )}`,
    );
    runtime.log?.(
      `[${account.accountId}] [zalo] image event payload (missing media URL): ${formatUpdateForLog(
        update,
      )}`,
    );
  }

  const inboundText = caption?.trim() || resolveInboundText(message);
  if (!mediaPath && !inboundText) {
    runtime.log?.(
      `[${account.accountId}] [zalo] image event dropped (no media/text to process): ${describeInboundImagePayload(
        message,
      )}`,
    );
    return;
  }

  await processMessageWithPipeline({
    message,
    token,
    account,
    config,
    runtime,
    core,
    text: inboundText,
    mediaPath,
    mediaType,
    statusSink,
    fetcher,
    sendRetryControl,
  });
}

function buildStickerTextHint(message: ZaloMessage, stickerUrl?: string): string {
  const stickerId = message.sticker?.trim();
  const messageType = message.message_type?.trim();
  const parts: string[] = [];
  if (stickerId) {
    parts.push(`[sticker:${stickerId}]`);
  } else {
    parts.push("[sticker]");
  }
  if (messageType) {
    parts.push(`[type:${messageType}]`);
  }
  if (stickerUrl) {
    parts.push(`[sticker_url:${stickerUrl}]`);
  }
  parts.push(
    "User sent a sticker.",
    "Reply with emoji only (1-3 emojis).",
    "Do not use words, punctuation, markdown, or media attachments.",
    "If meaning is unclear, send a friendly generic emoji reaction.",
  );
  return parts.join(" ");
}

async function handleStickerMessage(
  update: ZaloUpdate,
  message: ZaloMessage,
  token: string,
  account: ResolvedZaloAccount,
  config: OpenClawConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  mediaMaxMb: number,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
  sendRetryControl?: SendRetryControl,
): Promise<void> {
  runtime.log?.(
    `[${account.accountId}] [zalo] Sticker event payload: ${formatUpdateForLog(update)}`,
  );

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  const stickerUrl = resolveInboundStickerUrl(message);

  if (stickerUrl) {
    try {
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: stickerUrl,
        maxBytes,
      });
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
    } catch (err) {
      runtime.error?.(`[${account.accountId}] Failed to download Zalo sticker: ${String(err)}`);
    }
  } else {
    runtime.log?.(
      `[${account.accountId}] [zalo] sticker event has no downloadable URL: ${formatUpdateForLog(
        update,
      )}`,
    );
  }

  await processMessageWithPipeline({
    message,
    token,
    account,
    config,
    runtime,
    core,
    text: buildStickerTextHint(message, stickerUrl),
    mediaPath,
    mediaType,
    stickerReplyEmojiOnly: true,
    statusSink,
    fetcher,
    sendRetryControl,
  });
}

async function processMessageWithPipeline(params: {
  message: ZaloMessage;
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  text?: string;
  mediaPath?: string;
  mediaType?: string;
  stickerReplyEmojiOnly?: boolean;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
  sendRetryControl?: SendRetryControl;
}): Promise<void> {
  const {
    message,
    token,
    account,
    config,
    runtime,
    core,
    text,
    mediaPath,
    mediaType,
    stickerReplyEmojiOnly,
    statusSink,
    fetcher,
    sendRetryControl,
  } = params;
  const { message_id, date } = message;
  const rawBody = text?.trim() || (mediaPath ? "<media:image>" : "");
  const access = await enforceInboundDirectAccess({
    message,
    token,
    account,
    config,
    runtime,
    core,
    rawBody,
    statusSink,
    fetcher,
    sendRetryControl,
  });
  if (!access.allowed) {
    return;
  }
  const { isGroup, chatId, senderId, senderName, commandAuthorized } = access;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config,
    channel: "zalo",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? ("group" as const) : ("direct" as const),
      id: chatId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `zalo: drop control command from unauthorized sender ${senderId}`);
    return;
  }

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    channel: "Zalo",
    from: fromLabel,
    timestamp: date ? date * 1000 : undefined,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `zalo:group:${chatId}` : `zalo:${senderId}`,
    To: `zalo:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "zalo",
    Surface: "zalo",
    MessageSid: message_id,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "zalo",
    OriginatingTo: `zalo:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`zalo: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "zalo",
    accountId: account.accountId,
  });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "zalo",
    accountId: account.accountId,
  });
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      await sendChatAction(
        token,
        {
          chat_id: chatId,
          action: "typing",
        },
        fetcher,
        ZALO_TYPING_TIMEOUT_MS,
      );
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => logVerbose(core, runtime, message),
        channel: "zalo",
        action: "start",
        target: chatId,
        error: err,
      });
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      typingCallbacks,
      deliver: async (payload) => {
        await deliverZaloReply({
          payload,
          token,
          chatId,
          runtime,
          core,
          config,
          accountId: account.accountId,
          stickerReplyEmojiOnly,
          statusSink,
          fetcher,
          tableMode,
          sendRetryControl,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] Zalo ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function deliverZaloReply(params: {
  payload: OutboundReplyPayload;
  token: string;
  chatId: string;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  stickerReplyEmojiOnly?: boolean;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
  tableMode?: MarkdownTableMode;
  sendRetryControl?: SendRetryControl;
}): Promise<void> {
  const {
    payload,
    token,
    chatId,
    runtime,
    core,
    config,
    accountId,
    stickerReplyEmojiOnly,
    statusSink,
    fetcher,
    sendRetryControl,
  } = params;
  const tableMode = params.tableMode ?? "code";
  const convertedText = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
  const text = stickerReplyEmojiOnly ? toEmojiOnlyReplyText(convertedText) : convertedText;
  const mediaUrls = stickerReplyEmojiOnly ? [] : resolveOutboundMediaUrls(payload);

  const sentMedia = await sendMediaWithLeadingCaption({
    mediaUrls,
    caption: text,
    send: async ({ mediaUrl, caption }) => {
      await runWithSendRetry({
        runtime,
        accountId: accountId ?? "default",
        actionLabel: "send photo",
        operation: () => sendPhoto(token, { chat_id: chatId, photo: mediaUrl, caption }, fetcher),
        sendRetryControl,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    onError: (error) => {
      runtime.error?.(`Zalo photo send failed: ${String(error)}`);
    },
  });
  if (sentMedia) {
    return;
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "zalo", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(text, ZALO_TEXT_LIMIT, chunkMode);
    for (const chunk of chunks) {
      try {
        await runWithSendRetry({
          runtime,
          accountId: accountId ?? "default",
          actionLabel: "send message",
          operation: () => sendMessage(token, { chat_id: chatId, text: chunk }, fetcher),
          sendRetryControl,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Zalo message send failed: ${String(err)}`);
      }
    }
  }
}

export async function monitorZaloProvider(options: ZaloMonitorOptions): Promise<ZaloMonitorResult> {
  const {
    token,
    account,
    config,
    runtime,
    abortSignal,
    useWebhook,
    webhookUrl,
    webhookSecret,
    webhookPath,
    statusSink,
    fetcher: fetcherOverride,
  } = options;

  const core = getZaloRuntime();
  const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const fetcher = fetcherOverride ?? resolveZaloProxyFetch(account.config.proxy);
  const mode = useWebhook ? "webhook" : "polling";

  let stopped = false;
  const stopHandlers: Array<() => void> = [];
  let cleanupWebhook: (() => Promise<void>) | undefined;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const handler of stopHandlers) {
      try {
        handler();
      } catch (error) {
        runtime.error?.(`[${account.accountId}] Zalo stop handler failed: ${String(error)}`);
      }
    }
  };

  runtime.log?.(
    `[${account.accountId}] Zalo provider init mode=${mode} mediaMaxMb=${String(effectiveMediaMaxMb)}`,
  );

  try {
    if (useWebhook) {
      if (!webhookUrl || !webhookSecret) {
        throw new Error("Zalo webhookUrl and webhookSecret are required for webhook mode");
      }
      if (!webhookUrl.startsWith("https://")) {
        throw new Error("Zalo webhook URL must use HTTPS");
      }
      if (webhookSecret.length < 8 || webhookSecret.length > 256) {
        throw new Error("Zalo webhook secret must be 8-256 characters");
      }

      const path = resolveWebhookPath({ webhookPath, webhookUrl, defaultPath: null });
      if (!path) {
        throw new Error("Zalo webhookPath could not be derived");
      }

      runtime.log?.(
        `[${account.accountId}] Zalo configuring webhook path=${path} target=${describeWebhookTarget(webhookUrl)}`,
      );
      await setWebhook(token, { url: webhookUrl, secret_token: webhookSecret }, fetcher);
      let webhookCleanupPromise: Promise<void> | undefined;
      cleanupWebhook = async () => {
        if (!webhookCleanupPromise) {
          webhookCleanupPromise = (async () => {
            runtime.log?.(`[${account.accountId}] Zalo stopping; deleting webhook`);
            try {
              await deleteWebhook(token, fetcher, WEBHOOK_CLEANUP_TIMEOUT_MS);
              runtime.log?.(`[${account.accountId}] Zalo webhook deleted`);
            } catch (err) {
              const detail =
                err instanceof Error && err.name === "AbortError"
                  ? `timed out after ${String(WEBHOOK_CLEANUP_TIMEOUT_MS)}ms`
                  : formatZaloError(err);
              runtime.error?.(`[${account.accountId}] Zalo webhook delete failed: ${detail}`);
            }
          })();
        }
        await webhookCleanupPromise;
      };
      runtime.log?.(`[${account.accountId}] Zalo webhook registered path=${path}`);

      const unregister = registerZaloWebhookTarget({
        token,
        account,
        config,
        runtime,
        core,
        path,
        secret: webhookSecret,
        statusSink: (patch) => statusSink?.(patch),
        mediaMaxMb: effectiveMediaMaxMb,
        fetcher,
      });
      stopHandlers.push(unregister);
      await waitForAbort(abortSignal);
      return { stop };
    }

    runtime.log?.(`[${account.accountId}] Zalo polling mode: clearing webhook before startup`);
    try {
      try {
        const currentWebhookUrl = normalizeWebhookUrl(
          (await getWebhookInfo(token, fetcher)).result?.url,
        );
        if (!currentWebhookUrl) {
          runtime.log?.(`[${account.accountId}] Zalo polling mode ready (no webhook configured)`);
        } else {
          runtime.log?.(
            `[${account.accountId}] Zalo polling mode disabling existing webhook ${describeWebhookTarget(currentWebhookUrl)}`,
          );
          await deleteWebhook(token, fetcher);
          runtime.log?.(`[${account.accountId}] Zalo polling mode ready (webhook disabled)`);
        }
      } catch (err) {
        if (err instanceof ZaloApiError && err.errorCode === 404) {
          // Some Zalo environments do not expose webhook inspection for polling bots.
          runtime.log?.(
            `[${account.accountId}] Zalo polling mode webhook inspection unavailable; continuing without webhook cleanup`,
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      runtime.error?.(
        `[${account.accountId}] Zalo polling startup could not clear webhook: ${formatZaloError(err)}`,
      );
    }

    startPollingLoop({
      token,
      account,
      config,
      runtime,
      core,
      abortSignal,
      isStopped: () => stopped,
      mediaMaxMb: effectiveMediaMaxMb,
      statusSink,
      fetcher,
    });
    await waitForAbort(abortSignal);
    return { stop };
  } catch (err) {
    runtime.error?.(
      `[${account.accountId}] Zalo provider startup failed mode=${mode}: ${formatZaloError(err)}`,
    );
    throw err;
  } finally {
    await cleanupWebhook?.();
    stop();
    runtime.log?.(`[${account.accountId}] Zalo provider stopped mode=${mode}`);
  }
}

async function processUpdateForTesting(
  update: ZaloUpdate,
  runtime: ZaloRuntimeEnv = {},
  fetcher?: ZaloFetch,
  options: {
    accountConfig?: ResolvedZaloAccount["config"];
    core?: ZaloCoreRuntime;
  } = {},
): Promise<void> {
  const account: ResolvedZaloAccount = {
    accountId: "test",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: options.accountConfig ?? { dmPolicy: "open" },
  };
  const testCore =
    options.core ??
    ({
      logging: {
        shouldLogVerbose: () => false,
      },
      channel: {
        pairing: {
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => ({ code: "TEST-PAIR", created: false }),
          buildPairingReply: ({ idLine, code }: { idLine: string; code: string }) =>
            `${idLine}\nPairing code: ${code}`,
        },
        commands: {
          shouldComputeCommandAuthorized: () => false,
          resolveCommandAuthorizedFromAuthorizers: (params: {
            authorizers: Array<{ allowed: boolean }>;
          }) => params.authorizers.every((entry) => entry.allowed),
        },
      },
    } as unknown as ZaloCoreRuntime);
  await processUpdate(
    update,
    account.token,
    account,
    {} as OpenClawConfig,
    runtime,
    testCore,
    DEFAULT_MEDIA_MAX_MB,
    undefined,
    fetcher ?? (async () => new Response(JSON.stringify({ ok: true, result: {} }))),
  );
}

export const __testing = {
  buildStickerTextHint,
  buildUnsupportedMessageNotice,
  describeInboundImagePayload,
  formatUpdateForLog,
  isRetryableSendError,
  runWithSendRetry,
  toEmojiOnlyReplyText,
  processUpdateForTesting,
  resolveInboundImageUrl,
  resolveInboundStickerUrl,
  resolveInboundText,
  summarizeUnsupportedInbound,
};
