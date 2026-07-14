import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
// Discord plugin module implements outbound payload behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  getReplyPayloadTtsSupplement,
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
import type { DiscordSendResult } from "./send.types.js";

type DiscordOutboundPayloadContext = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0];
type DiscordPayloadSendContext = Awaited<ReturnType<typeof createDiscordPayloadSendContext>>;

function resolveDiscordDeliveryProgress(ctx: DiscordOutboundPayloadContext) {
  return ctx.onDeliveryResult
    ? async (result: Awaited<ReturnType<DiscordPayloadSendContext["send"]>>) => {
        await ctx.onDeliveryResult?.(attachChannelToResult("discord", result));
      }
    : undefined;
}

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
  reply = sendContext.resolveReply(),
) {
  return {
    reply,
    accountId: ctx.accountId ?? undefined,
    silent: ctx.silent ?? undefined,
    cfg: ctx.cfg,
  };
}

function resolveDiscordFormattedDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  reply = sendContext.resolveReply(),
) {
  return {
    ...resolveDiscordDeliveryOptions(ctx, sendContext, reply),
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

/** Maximum attachments Discord accepts in a single message. */
const DISCORD_MAX_PER_MSG = 10;

/** Send multiple media URLs in batched messages via mediaUrls[] (#24196).
 *  Each batch (≤10 files) is independently retried so a failure in a later
 *  batch does not re-send earlier ones. */
async function sendDiscordMediaBatch(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  params: {
    text: string;
    mediaUrls: string[];
    components?: DiscordSendComponents;
    embeds?: DiscordSendEmbeds;
    filename?: string | null;
  },
): Promise<DiscordSendResult> {
  const reportProgress = resolveDiscordDeliveryProgress(ctx);
  const allMessageIds: string[] = [];
  let lastResult: { messageId: string; channelId: string } | undefined;

  for (let offset = 0; offset < params.mediaUrls.length; offset += DISCORD_MAX_PER_MSG) {
    const batch = params.mediaUrls.slice(offset, offset + DISCORD_MAX_PER_MSG);
    const isFirst = offset === 0;
    // Resolve reply fresh per batch: resolveReply returns the value
    // once for single-use modes ("first") or repeatedly for "all"/"explicit".
    const batchReply = sendContext.resolveReply();

    // Discord cannot mix text captions with video attachments in a single
    // message.  When the first batch carries both text and video media, send
    // the caption as a separate text message first, then the media without text.
    const isVideoBatch = isFirst && params.text.trim() && batch.some(isLikelyDiscordVideoMedia);

    if (isVideoBatch) {
      // Send caption as plain text (with replyTo), then media without text.
      // Use explicit options so the already-captured batchReplyTo is not
      // re-consumed by resolveDiscordFormattedDeliveryOptions.
      lastResult = await sendContext.send(sendContext.target, params.text, {
        verbose: false,
        reply: batchReply,
        accountId: ctx.accountId ?? undefined,
        silent: ctx.silent ?? undefined,
        cfg: ctx.cfg,
        ...sendContext.formatting,
      });

      if (lastResult?.messageId) {
        allMessageIds.push(lastResult.messageId);
      }
      await reportProgress?.(lastResult as Parameters<NonNullable<typeof reportProgress>>[0]);
      // Media-only leg: only pass reply when scope is "all" (P2 fix).
      // For scope "first" the reply is consumed by the caption send above.
      const mediaReply = batchReply?.scope === "all" ? batchReply : undefined;
      if (batch.length === 1) {
        lastResult = await sendContext.send(sendContext.target, "", {
          verbose: false,
          mediaUrl: batch[0],
          mediaAccess: ctx.mediaAccess,
          mediaLocalRoots: ctx.mediaLocalRoots,
          mediaReadFile: ctx.mediaReadFile,
          reply: mediaReply,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
          ...sendContext.formatting,
        });
      } else {
        lastResult = await sendContext.send(sendContext.target, "", {
          verbose: false,
          mediaUrls: batch,
          mediaAccess: ctx.mediaAccess,
          mediaLocalRoots: ctx.mediaLocalRoots,
          mediaReadFile: ctx.mediaReadFile,
          reply: mediaReply,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
          ...sendContext.formatting,
        });
      }
    } else if (batch.length === 1 && !isFirst) {
      // Single file after first batch: no text, only media options.
      // Carry forward silent mode so single-file overflow batches
      // suppress notifications when the caller requests it.
      lastResult = await sendContext.send(sendContext.target, "", {
        verbose: false,
        mediaUrl: batch[0],
        mediaAccess: ctx.mediaAccess,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
        reply: batchReply,
        accountId: ctx.accountId ?? undefined,
        silent: ctx.silent ?? undefined,
        cfg: ctx.cfg,
        ...sendContext.formatting,
      });
    } else if (batch.length === 1) {
      lastResult = await sendContext.send(sendContext.target, params.text, {
        verbose: false,
        ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, batch[0]),
        components: params.components,
        embeds: params.embeds,
        filename: params.filename ?? undefined,
      });
    } else {
      lastResult = await sendContext.send(sendContext.target, isFirst ? params.text : "", {
        verbose: false,
        mediaUrls: batch,
        mediaAccess: ctx.mediaAccess,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
        reply: batchReply,
        accountId: ctx.accountId ?? undefined,
        silent: ctx.silent ?? undefined,
        cfg: ctx.cfg,
        ...sendContext.formatting,
        components: isFirst ? params.components : undefined,
        embeds: isFirst ? params.embeds : undefined,
        filename: isFirst ? (params.filename ?? undefined) : undefined,
      });
    }

    await reportProgress?.(lastResult as Parameters<NonNullable<typeof reportProgress>>[0]);

    // Collect message IDs from every batch so overflow receipt metadata
    // includes all emitted message IDs, not just the last batch.
    if (lastResult?.messageId) {
      allMessageIds.push(lastResult.messageId);
    }
  }

  if (!lastResult) {
    return {
      messageId: "",
      channelId: sendContext.target,
      receipt: createDiscordSendReceipt({
        platformMessageIds: [],
        channelId: sendContext.target,
        kind: "media",
      }),
    };
  }
  // Build a proper receipt aggregated from ALL batch message IDs, not just
  // the last batch (which is what lastResult.receipt contains).
  return {
    ...lastResult,
    receipt: createDiscordSendReceipt({
      platformMessageIds: allMessageIds,
      channelId: lastResult.channelId,
      kind: "media",
    }),
  };
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
    const voiceReply = sendContext.resolveReply();
    let deliveredVoice = false;
    let lastResult: Awaited<ReturnType<DiscordPayloadSendContext["send"]>>;
    try {
      const voiceUrl = expectDefined(mediaUrls.at(0), "non-empty Discord voice media URLs");
      lastResult = await sendContext.sendVoice(sendContext.target, voiceUrl, {
        ...resolveDiscordDeliveryOptions(ctx, sendContext, voiceReply),
      });
      deliveredVoice = true;
    } catch (err) {
      const supplement = getReplyPayloadTtsSupplement(payload);
      const visibleFallbackText = payload.text?.trim() ? payload.text : undefined;
      const hiddenFallbackText = supplement?.visibleTextAlreadyDelivered
        ? undefined
        : supplement?.spokenText;
      const fallbackText = visibleFallbackText ?? hiddenFallbackText;
      if (!fallbackText) {
        if (supplement?.visibleTextAlreadyDelivered) {
          lastResult = createDiscordUnknownPayloadResult(sendContext.target);
        } else {
          throw err;
        }
      } else {
        lastResult = await sendContext.send(sendContext.target, fallbackText, {
          verbose: false,
          ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext, voiceReply),
          onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
        });
      }
    }
    if (deliveredVoice) {
      await ctx.onDeliveryResult?.(attachChannelToResult("discord", lastResult));
    }
    if (deliveredVoice && payload.text?.trim()) {
      lastResult = await sendContext.send(sendContext.target, payload.text, {
        verbose: false,
        ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
        onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
      });
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      lastResult = await sendContext.send(sendContext.target, "", {
        verbose: false,
        ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
        onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
      });
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
        const result = await sendDiscordMediaBatch(ctx, sendContext, {
          text: payload.text ?? "",
          mediaUrls,
          components: nativeComponents,
          embeds,
          filename,
        });
        return attachChannelToResult("discord", result);
      }
      const result = await sendPayloadMediaSequenceOrFallback({
        text: payload.text ?? "",
        mediaUrls,
        fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
        sendNoMedia: async () =>
          await sendContext.send(sendContext.target, payload.text ?? "", {
            verbose: false,
            components: nativeComponents,
            embeds,
            filename,
            ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
            onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
          }),
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendContext.send(sendContext.target, text, {
            verbose: false,
            ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
            components: isFirst ? nativeComponents : undefined,
            embeds: isFirst ? embeds : undefined,
            filename: isFirst ? filename : undefined,
            onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
          }),
      });
      return attachChannelToResult("discord", result);
    }
    if (mediaUrls.length > 1) {
      const result = await sendDiscordMediaBatch(ctx, sendContext, {
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
    sendNoMedia: async () => {
      return await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
        ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
        onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
      });
    },
    send: async ({ text, mediaUrl, isFirst }) => {
      if (isFirst) {
        return await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
          ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
          onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
        });
      }
      return await sendContext.send(sendContext.target, text, {
        verbose: false,
        ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
        onDeliveryResult: resolveDiscordDeliveryProgress(ctx),
      });
    },
  });
  return attachChannelToResult("discord", result);
}
