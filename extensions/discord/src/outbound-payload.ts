// Discord plugin module implements outbound payload behavior.
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isLikelyDiscordVideoMedia } from "./media-detection.js";
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
) {
  return {
    replyTo: sendContext.resolveReplyTo(),
    accountId: ctx.accountId ?? undefined,
    silent: ctx.silent ?? undefined,
    cfg: ctx.cfg,
  };
}

function resolveDiscordFormattedDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
) {
  return {
    ...resolveDiscordDeliveryOptions(ctx, sendContext),
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

function resolveDiscordMultiMediaDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  mediaUrls: readonly string[],
) {
  return {
    mediaUrls,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
  };
}

async function sendDiscordPlainMultiMediaPayload(params: {
  ctx: DiscordOutboundPayloadContext;
  sendContext: DiscordPayloadSendContext;
  text: string;
  mediaUrls: readonly string[];
}) {
  const text = params.text;
  if (text.trim() && params.mediaUrls.some(isLikelyDiscordVideoMedia)) {
    await params.sendContext.withRetry(
      async () =>
        await params.sendContext.send(params.sendContext.target, text, {
          verbose: false,
          ...resolveDiscordFormattedDeliveryOptions(params.ctx, params.sendContext),
        }),
    );
    return await params.sendContext.withRetry(
      async () =>
        await params.sendContext.send(params.sendContext.target, "", {
          verbose: false,
          ...resolveDiscordMultiMediaDeliveryOptions(
            params.ctx,
            params.sendContext,
            params.mediaUrls,
          ),
        }),
    );
  }
  return await params.sendContext.withRetry(
    async () =>
      await params.sendContext.send(params.sendContext.target, text, {
        verbose: false,
        ...resolveDiscordMultiMediaDeliveryOptions(
          params.ctx,
          params.sendContext,
          params.mediaUrls,
        ),
      }),
  );
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
    // audioAsVoice emits one logical Discord reply across voice/text/media sends.
    // Capture before helper calls consume implicit single-use reply targets.
    const voiceReplyTo = sendContext.resolveReplyTo();
    let lastResult = await sendContext.withRetry(
      async () =>
        await sendContext.sendVoice(sendContext.target, mediaUrls[0], {
          ...resolveDiscordDeliveryOptions(ctx, sendContext),
          replyTo: voiceReplyTo,
        }),
    );
    if (payload.text?.trim()) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, payload.text, {
            verbose: false,
            ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
            replyTo: voiceReplyTo,
          }),
      );
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, "", {
            verbose: false,
            ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
            replyTo: voiceReplyTo,
          }),
      );
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
      if (mediaUrls.length > 1) {
        const result = await sendContext.withRetry(
          async () =>
            await sendContext.send(sendContext.target, payload.text ?? "", {
              verbose: false,
              ...resolveDiscordMultiMediaDeliveryOptions(ctx, sendContext, mediaUrls),
              components: nativeComponents,
              embeds,
              filename,
            }),
        );
        return attachChannelToResult("discord", result);
      }
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
    if (mediaUrls.length > 1) {
      const result = await sendDiscordPlainMultiMediaPayload({
        ctx,
        sendContext,
        text: payload.text ?? "",
        mediaUrls,
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
