// Discord plugin module implements outbound payload behavior.
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  getReplyPayloadTtsSupplement,
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  resolveDiscordComponentSpec,
  sendDiscordComponentMessageLazy,
} from "./outbound-components.js";
import { createDiscordPayloadSendContext } from "./outbound-send-context.js";
import { createDiscordSendReceipt } from "./send.receipt.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "./send.shared.js";

type DiscordOutboundPayloadContext = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0];
type DiscordPayloadSendContext = Awaited<ReturnType<typeof createDiscordPayloadSendContext>>;
type DiscordPayloadSendResult = Awaited<ReturnType<DiscordPayloadSendContext["send"]>>;

function createDiscordUnknownPayloadResult(target: string) {
  return {
    messageId: "",
    channelId: target,
    receipt: createDiscordSendReceipt({
      platformMessageIds: [],
      channelId: target,
      kind: "unknown",
    }),
  };
}

function resolveDiscordDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  options?: { replyTo?: string },
) {
  return {
    replyTo: options?.replyTo ?? sendContext.resolveReplyTo(),
    accountId: ctx.accountId ?? undefined,
    silent: ctx.silent ?? undefined,
    cfg: ctx.cfg,
  };
}

function resolveDiscordFormattedDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  options?: { replyTo?: string },
) {
  return {
    ...resolveDiscordDeliveryOptions(ctx, sendContext, options),
    ...sendContext.formatting,
  };
}

function resolveDiscordMediaDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  mediaUrl: string,
) {
  return {
    mediaUrl,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
  };
}

function resolveAudioAsVoiceFallbackText(
  payload: Pick<ReplyPayload, "text" | "ttsSupplement" | "mediaUrl" | "mediaUrls">,
): { text?: string; suppressVoiceFailure?: boolean } {
  const text = payload.text?.trim();
  if (text) {
    return { text };
  }
  const ttsSupplement = getReplyPayloadTtsSupplement(payload);
  if (!ttsSupplement) {
    return {};
  }
  if (ttsSupplement.visibleTextAlreadyDelivered) {
    return { suppressVoiceFailure: true };
  }
  return { text: ttsSupplement.spokenText };
}

async function sendDiscordPayloadText(params: {
  ctx: DiscordOutboundPayloadContext;
  sendContext: DiscordPayloadSendContext;
  text: string;
  replyTo?: string;
}): Promise<DiscordPayloadSendResult> {
  return await params.sendContext.withRetry(
    async () =>
      await params.sendContext.send(params.sendContext.target, params.text, {
        verbose: false,
        ...resolveDiscordFormattedDeliveryOptions(params.ctx, params.sendContext, {
          replyTo: params.replyTo,
        }),
      }),
  );
}

async function sendDiscordPayloadMedia(params: {
  ctx: DiscordOutboundPayloadContext;
  sendContext: DiscordPayloadSendContext;
  mediaUrl: string;
}): Promise<DiscordPayloadSendResult> {
  return await params.sendContext.withRetry(
    async () =>
      await params.sendContext.send(params.sendContext.target, "", {
        verbose: false,
        ...resolveDiscordMediaDeliveryOptions(params.ctx, params.sendContext, params.mediaUrl),
      }),
  );
}

async function sendDiscordVoiceOrTextFallback(params: {
  ctx: DiscordOutboundPayloadContext;
  sendContext: DiscordPayloadSendContext;
  mediaUrl: string;
  fallbackText?: string;
  suppressVoiceFailure?: boolean;
}): Promise<{ result: DiscordPayloadSendResult; deliveredVoice: boolean }> {
  const replyTo = params.sendContext.resolveReplyTo();
  try {
    const result = await params.sendContext.withRetry(
      async () =>
        await params.sendContext.sendVoice(
          params.sendContext.target,
          params.mediaUrl,
          resolveDiscordDeliveryOptions(params.ctx, params.sendContext, { replyTo }),
        ),
    );
    return { result, deliveredVoice: true };
  } catch (err) {
    if (!params.fallbackText) {
      if (params.suppressVoiceFailure) {
        return {
          result: createDiscordUnknownPayloadResult(params.sendContext.target),
          deliveredVoice: false,
        };
      }
      throw err;
    }
    const result = await sendDiscordPayloadText({
      ctx: params.ctx,
      sendContext: params.sendContext,
      text: params.fallbackText,
      replyTo,
    });
    return { result, deliveredVoice: false };
  }
}

export async function sendDiscordOutboundPayload(params: {
  ctx: DiscordOutboundPayloadContext;
  fallbackAdapter: ChannelOutboundAdapter;
}): Promise<Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>> {
  const ctx = params.ctx;
  const payload = normalizeDiscordApprovalPayload({
    ...ctx.payload,
    text: ctx.payload.text ?? "",
  });
  const mediaUrls = resolvePayloadMediaUrls(payload);
  const sendContext = await createDiscordPayloadSendContext(ctx);

  if (payload.audioAsVoice && mediaUrls.length > 0) {
    const fallback = resolveAudioAsVoiceFallbackText(payload);
    const firstDelivery = await sendDiscordVoiceOrTextFallback({
      ctx,
      sendContext,
      mediaUrl: mediaUrls[0],
      fallbackText: fallback.text,
      suppressVoiceFailure: fallback.suppressVoiceFailure,
    });
    let lastResult = firstDelivery.result;
    if (firstDelivery.deliveredVoice && payload.text?.trim()) {
      lastResult = await sendDiscordPayloadText({
        ctx,
        sendContext,
        text: payload.text,
      });
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      lastResult = await sendDiscordPayloadMedia({ ctx, sendContext, mediaUrl });
    }
    return attachChannelToResult("discord", lastResult);
  }

  const componentSpec = await resolveDiscordComponentSpec(payload);
  if (!componentSpec) {
    const discordData =
      payload.channelData?.discord &&
      typeof payload.channelData.discord === "object" &&
      !Array.isArray(payload.channelData.discord)
        ? (payload.channelData.discord as Record<string, unknown>)
        : {};
    const nativeComponents = Array.isArray(discordData.components)
      ? (discordData.components as DiscordSendComponents)
      : undefined;
    const embeds = Array.isArray(discordData.embeds)
      ? (discordData.embeds as DiscordSendEmbeds)
      : undefined;
    const filename = normalizeOptionalString(discordData.filename);
    if (nativeComponents || embeds?.length || filename) {
      const result = await sendPayloadMediaSequenceOrFallback({
        text: payload.text ?? "",
        mediaUrls,
        fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
        sendNoMedia: async () =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, payload.text ?? "", {
                verbose: false,
                components: nativeComponents,
                embeds,
                filename,
                ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
              }),
          ),
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, text, {
                verbose: false,
                ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
                components: isFirst ? nativeComponents : undefined,
                embeds: isFirst ? embeds : undefined,
                filename: isFirst ? filename : undefined,
              }),
          ),
      });
      return attachChannelToResult("discord", result);
    }
    return await sendTextMediaPayload({
      channel: "discord",
      ctx: {
        ...ctx,
        payload,
      },
      adapter: params.fallbackAdapter,
    });
  }

  const result = await sendPayloadMediaSequenceOrFallback({
    text: payload.text ?? "",
    mediaUrls,
    fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
    sendNoMedia: async () =>
      await sendContext.withRetry(
        async () =>
          await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
            ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
          }),
      ),
    send: async ({ text, mediaUrl, isFirst }) => {
      if (isFirst) {
        return await sendContext.withRetry(
          async () =>
            await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
              ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
            }),
        );
      }
      return await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, text, {
            verbose: false,
            ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
          }),
      );
    },
  });
  return attachChannelToResult("discord", result);
}
