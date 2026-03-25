import {
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  formatErrorMessage,
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/infra-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolveSendableOutboundReplyParts,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
import { createSubsystemLogger, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppOutboundTarget } from "./runtime-api.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "./send.js";

const log = createSubsystemLogger("gateway/channels/whatsapp").child("send-retry");

const WHATSAPP_SEND_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies Required<RetryConfig>;

// Only retry clearly transient network errors to avoid duplicate message delivery.
const WHATSAPP_SEND_RETRY_RE = /timeout|connect|reset|closed|unavailable|temporarily/i;

function shouldRetryWhatsAppSend(err: unknown): boolean {
  return WHATSAPP_SEND_RETRY_RE.test(formatErrorMessage(err));
}

function withWhatsAppSendRetry<T>(
  fn: () => Promise<T>,
  label: string,
  configRetry: RetryConfig | undefined,
): Promise<T> {
  const resolved = resolveRetryConfig(WHATSAPP_SEND_RETRY_DEFAULTS, configRetry);
  return retryAsync(fn, {
    ...resolved,
    label,
    shouldRetry: shouldRetryWhatsAppSend,
    onRetry: (info) => {
      const maxRetries = Math.max(1, info.maxAttempts - 1);
      log.warn(
        `whatsapp send retry ${info.attempt}/${maxRetries} for ${info.label ?? label} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
      );
    },
  });
}

function trimLeadingWhitespace(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  sendPayload: async (ctx) => {
    const text = trimLeadingWhitespace(ctx.payload.text);
    const hasMedia = resolveSendableOutboundReplyParts(ctx.payload).hasMedia;
    if (!text && !hasMedia) {
      return createEmptyChannelResult("whatsapp");
    }
    return await sendTextMediaPayload({
      channel: "whatsapp",
      ctx: {
        ...ctx,
        payload: {
          ...ctx.payload,
          text,
        },
      },
      adapter: whatsappOutbound,
    });
  },
  ...createAttachedChannelResultAdapter({
    channel: "whatsapp",
    sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
      const normalizedText = trimLeadingWhitespace(text);
      if (!normalizedText) {
        return createEmptyChannelResult("whatsapp");
      }
      const send =
        resolveOutboundSendDep<typeof import("./send.js").sendMessageWhatsApp>(deps, "whatsapp") ??
        (await import("./send.js")).sendMessageWhatsApp;
      return await withWhatsAppSendRetry(
        () =>
          send(to, normalizedText, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
            gifPlayback,
          }),
        "sendText",
        cfg.channels?.whatsapp?.retry,
      );
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      gifPlayback,
    }) => {
      const normalizedText = trimLeadingWhitespace(text);
      const send =
        resolveOutboundSendDep<typeof import("./send.js").sendMessageWhatsApp>(deps, "whatsapp") ??
        (await import("./send.js")).sendMessageWhatsApp;
      return await withWhatsAppSendRetry(
        () =>
          send(to, normalizedText, {
            verbose: false,
            cfg,
            mediaUrl,
            mediaLocalRoots,
            mediaReadFile,
            accountId: accountId ?? undefined,
            gifPlayback,
          }),
        "sendMedia",
        cfg.channels?.whatsapp?.retry,
      );
    },
    sendPoll: async ({ cfg, to, poll, accountId }) =>
      await withWhatsAppSendRetry(
        () =>
          sendPollWhatsApp(to, poll, {
            verbose: shouldLogVerbose(),
            accountId: accountId ?? undefined,
            cfg,
          }),
        "sendPoll",
        cfg.channels?.whatsapp?.retry,
      ),
  }),
};
