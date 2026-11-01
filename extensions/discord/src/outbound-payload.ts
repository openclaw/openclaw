import { createReplyToFanout, resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import {
  getReplyPayloadTtsSupplement,
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalRecord,
  normalizeOptionalString,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createDiscordActionGate } from "./accounts.js";
import { formatDiscordApprovalDisplayValue } from "./approval-message-safety.js";
import { resolveDiscordAttachedOutboundTarget } from "./channel.conversation.js";
import { chunkDiscordTextWithMode } from "./chunk.js";
import {
  discordInboundEventDelivery,
  notifyDiscordInboundEventOutboundPayloadSuccess,
} from "./inbound-event-delivery.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import {
  resolveDiscordComponentSpec,
  sendDiscordComponentMessageLazy,
  buildDiscordPresentationPayload,
  DISCORD_PRESENTATION_CAPABILITIES,
} from "./outbound-components.js";
import { resolveDiscordReplyReference } from "./reply-reference.js";
import { hasDiscordMessageCreateAmbiguity, canFallbackDiscordWebhookSend } from "./retry.js";
import {
  createDiscordSendReceipt,
  createDiscordSendReceiptFromResults,
  toDiscordOutboundDeliveryResult,
} from "./send.receipt.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";

type DiscordSendRuntime = typeof import("./send.js");

type DiscordSendFn = DiscordSendRuntime["sendMessageDiscord"];
type DiscordVoiceSendFn = DiscordSendRuntime["sendVoiceMessageDiscord"];
type DiscordOutboundContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

const loadDiscordSendRuntime = createLazyRuntimeModule(() => import("./send.js"));

function resolveDiscordDeliveryOptions(ctx: DiscordOutboundContext) {
  return {
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    assertPlatformSendAuthorized: ctx.assertDirectAdapterHandoff,
    onDeliveryResult: ctx.onDeliveryResult
      ? async (result: DiscordSendResult) =>
          ctx.onDeliveryResult?.(
            attachChannelToResult("discord", toDiscordOutboundDeliveryResult(result)),
          )
      : undefined,
  };
}

async function createDiscordOutboundSendContext(ctx: DiscordOutboundContext) {
  const nextReplyToId = createReplyToFanout(ctx);
  const resolveReply = () =>
    resolveDiscordReplyReference({
      replyToId: nextReplyToId(),
      replyToIdSource: ctx.replyToIdSource,
      replyToMode: ctx.replyToMode,
    });
  const delivery = resolveDiscordDeliveryOptions(ctx);
  const common = {
    accountId: ctx.accountId ?? undefined,
    silent: ctx.silent ?? undefined,
    cfg: ctx.cfg,
    signal: ctx.signal,
    onPlatformSendDispatch: delivery.onPlatformSendDispatch,
    assertPlatformSendAuthorized: delivery.assertPlatformSendAuthorized,
  };
  const media = {
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  };
  const options = (reply = resolveReply()) => ({
    ...common,
    verbose: false,
    reply,
    textLimit: ctx.formatting?.textLimit,
    maxLinesPerMessage: ctx.formatting?.maxLinesPerMessage,
    tableMode: ctx.formatting?.tableMode,
    chunkMode: ctx.formatting?.chunkMode,
    onDeliveryResult: delivery.onDeliveryResult,
  });
  return {
    target: resolveDiscordAttachedOutboundTarget(ctx),
    resolveReply,
    options,
    mediaOptions: (mediaUrl: string | undefined, reply = resolveReply()) => ({
      ...options(reply),
      mediaUrl,
      ...media,
    }),
    voiceOptions: (reply = resolveReply()) => ({ ...common, reply, ...media }),
    onDeliveryResult: delivery.onDeliveryResult,
    send:
      resolveOutboundSendDep<DiscordSendFn>(ctx.deps, "discord") ??
      (await loadDiscordSendRuntime()).sendMessageDiscord,
    sendVoice: async (...args: Parameters<DiscordVoiceSendFn>) =>
      await (
        resolveOutboundSendDep<DiscordVoiceSendFn>(ctx.deps, "discordVoice") ??
        (await loadDiscordSendRuntime()).sendVoiceMessageDiscord
      )(...args),
  };
}

function normalizeDiscordApprovalPayload<
  T extends {
    text?: string;
    channelData?: unknown;
  },
>(payload: T): T {
  if (!asOptionalRecord(payload.channelData)?.execApproval || !payload.text) {
    return payload;
  }
  return {
    ...payload,
    text: payload.text
      .replace(/@everyone/gi, "@\u200beveryone")
      .replace(/@here/gi, "@\u200bhere")
      .replace(/<@/g, "<@\u200b")
      .replace(/<#/g, "<#\u200b"),
  };
}

const payloadLog = createSubsystemLogger("discord/outbound");

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

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;
// Shared planning owns explicit per-send limits; Discord's sender resolves account config/defaults.
const DISCORD_PRECHUNK_MAX_LINES = Number.MAX_SAFE_INTEGER;
const DISCORD_VIDEO_MEDIA_EXTENSIONS = [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"];
const log = createSubsystemLogger("discord/outbound");
const loadDiscordThreadBindings = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.js"),
);
const loadDiscordComponentSendRuntime = createLazyRuntimeModule(
  () => import("./send.components.js"),
);

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit, ctx) =>
    chunkDiscordTextWithMode(text, {
      maxChars: limit,
      maxLines: ctx?.formatting?.maxLinesPerMessage ?? DISCORD_PRECHUNK_MAX_LINES,
    }),
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  pollMaxOptions: 10,
  normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
  presentationCapabilities: DISCORD_PRESENTATION_CAPABILITIES,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      poll: true,
      payload: true,
      silent: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  renderPresentation: buildDiscordPresentationPayload,
  resolveTarget: ({ to, allowFrom }) => normalizeDiscordOutboundTarget(to, allowFrom),
  sendPayload: async (ctx) => {
    const payload = normalizeDiscordApprovalPayload({
      ...ctx.payload,
      text: ctx.payload.text ?? "",
    });
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const payloadContext = { ...ctx, payload };
    const deliveredResults: DiscordSendResult[] = [];
    let createdThreadId: string | undefined;
    payloadContext.onDeliveryResult = async (result) => {
      await ctx.onDeliveryResult?.(result);
      const threadId = result.receipt?.threadId;
      if (threadId && payloadContext.threadId == null) {
        // A forum starter owns the thread used by every later payload delivery.
        payloadContext.threadId = threadId;
        sendContext.target = `channel:${threadId}`;
        createdThreadId = threadId;
      }
      if (createdThreadId && result.target?.kind === "channel" && result.receipt) {
        deliveredResults.push({
          messageId: result.messageId,
          channelId: result.target.id,
          receipt: result.receipt,
        });
      }
    };
    const sendContext = await createDiscordOutboundSendContext(payloadContext);
    const completeResult = <T extends { receipt?: DiscordSendResult["receipt"] }>(result: T): T =>
      createdThreadId
        ? {
            ...result,
            receipt: createDiscordSendReceiptFromResults({
              results: deliveredResults,
              threadId: createdThreadId,
            }),
          }
        : result;
    const completeDelivery = (result: DiscordSendResult) =>
      attachChannelToResult("discord", toDiscordOutboundDeliveryResult(completeResult(result)));

    if (payload.audioAsVoice && mediaUrls.length > 0) {
      // Defer voice failure until independent remainder sends finish while preserving progress.
      const voiceReply = sendContext.resolveReply();
      let voiceFailure: { error: unknown } | undefined;
      let lastResult = createDiscordUnknownPayloadResult(sendContext.target);
      try {
        const voiceUrl = expectDefined(mediaUrls.at(0), "non-empty Discord voice media URLs");
        lastResult = await sendContext.sendVoice(
          sendContext.target,
          voiceUrl,
          sendContext.voiceOptions(voiceReply),
        );
      } catch (err) {
        // A lost create response can hide a committed voice; a text retry has a different nonce.
        if (hasDiscordMessageCreateAmbiguity(err)) {
          throw err;
        }
        const supplement = getReplyPayloadTtsSupplement(payload);
        const visibleFallbackText = payload.text?.trim() ? payload.text : undefined;
        const hiddenFallbackText = supplement?.visibleTextAlreadyDelivered
          ? undefined
          : supplement?.spokenText;
        const fallbackText = visibleFallbackText ?? hiddenFallbackText;
        if (!fallbackText && !supplement?.visibleTextAlreadyDelivered) {
          throw err;
        }
        payloadLog.warn("discord voice send failed; continuing without voice", { error: err });
        if (fallbackText) {
          await sendContext.send(sendContext.target, fallbackText, sendContext.options(voiceReply));
        }
        voiceFailure = { error: err };
      }
      if (!voiceFailure) {
        await sendContext.onDeliveryResult?.(lastResult);
        if (payload.text?.trim()) {
          lastResult = await sendContext.send(
            sendContext.target,
            payload.text,
            sendContext.options(),
          );
        }
      }
      for (const mediaUrl of mediaUrls.slice(1)) {
        try {
          lastResult = await sendContext.send(
            sendContext.target,
            "",
            sendContext.mediaOptions(mediaUrl),
          );
        } catch (err) {
          if (!voiceFailure) {
            throw err;
          }
          // Keep the requested voice failure as the durable outcome while allowing the
          // remaining media loop to finish; later errors must not hide the primary failure.
          payloadLog.warn("discord remaining media send failed after voice failure", {
            error: err,
          });
        }
      }
      if (voiceFailure) {
        throw voiceFailure.error;
      }
      return completeDelivery(lastResult);
    }

    const discordData = asOptionalRecord(payload.channelData?.discord) ?? {};
    const filename = normalizeOptionalString(discordData.filename);
    const componentSpec = await resolveDiscordComponentSpec(payload);
    const nativeComponents =
      !componentSpec && Array.isArray(discordData.components)
        ? (discordData.components as DiscordSendComponents)
        : undefined;
    const embeds =
      !componentSpec && Array.isArray(discordData.embeds)
        ? (discordData.embeds as DiscordSendEmbeds)
        : undefined;
    if (!componentSpec && !nativeComponents && !embeds?.length && !filename) {
      const result = await sendTextMediaPayload({
        channel: "discord",
        ctx: payloadContext,
        adapter: discordOutbound,
      });
      return completeResult(result);
    }

    const result = await sendPayloadMediaSequenceOrFallback({
      text: payload.text ?? "",
      mediaUrls,
      fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
      sendNoMedia: async () =>
        componentSpec
          ? await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
              ...sendContext.options(),
              filename,
            })
          : await sendContext.send(sendContext.target, payload.text ?? "", {
              components: nativeComponents,
              embeds,
              filename,
              ...sendContext.options(),
            }),
      send: async ({ text, mediaUrl, isFirst }) => {
        if (componentSpec && isFirst) {
          return await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
            ...sendContext.mediaOptions(mediaUrl),
            filename,
          });
        }
        return await sendContext.send(sendContext.target, text, {
          ...sendContext.mediaOptions(mediaUrl),
          ...(!componentSpec
            ? {
                components: isFirst ? nativeComponents : undefined,
                embeds: isFirst ? embeds : undefined,
                filename: isFirst ? filename : undefined,
              }
            : {}),
        });
      },
    });
    return completeDelivery(result);
  },
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async (ctx) => {
      // Execute Webhook cannot create native replies; use the bot message endpoint.
      if (!ctx.silent && !resolveDiscordReplyReference(ctx)) {
        try {
          const threadId = normalizeOptionalStringifiedId(ctx.threadId) ?? "";
          if (threadId) {
            const { getThreadBindingManager } = await loadDiscordThreadBindings();
            const binding = getThreadBindingManager(ctx.accountId ?? undefined)?.getByThreadId(
              threadId,
            );
            if (binding?.webhookId && binding.webhookToken) {
              const username =
                normalizeOptionalString(ctx.identity?.name) ||
                normalizeOptionalString(binding.label) ||
                binding.agentId ||
                "";
              const { sendWebhookMessageDiscord } = await loadDiscordSendRuntime();
              const webhookResult = await sendWebhookMessageDiscord(ctx.text, {
                webhookId: binding.webhookId,
                webhookToken: binding.webhookToken,
                accountId: binding.accountId,
                threadId: binding.threadId,
                cfg: ctx.cfg,
                signal: ctx.signal,
                username: truncateUtf16Safe(username, 80) || undefined,
                avatarUrl: normalizeOptionalString(ctx.identity?.avatarUrl),
                tableMode: ctx.formatting?.tableMode,
                chunking: {
                  maxChars: ctx.formatting?.textLimit,
                  maxLines: ctx.formatting?.maxLinesPerMessage,
                },
                ...resolveDiscordDeliveryOptions(ctx),
              });
              if (webhookResult) {
                return toDiscordOutboundDeliveryResult(webhookResult);
              }
            }
          }
        } catch (error) {
          if (!canFallbackDiscordWebhookSend(error)) {
            throw error;
          }
          // Falling back to the plain bot send is intended (persona delivery is
          // best-effort), but the failure must stay operator-visible: a broken
          // webhook binding otherwise degrades every reply silently.
          log.warn("discord webhook persona send failed; falling back to bot send", { error });
        }
      }
      const prepared = await createDiscordOutboundSendContext(ctx);
      return toDiscordOutboundDeliveryResult(
        await prepared.send(prepared.target, ctx.text, prepared.options()),
      );
    },
    sendMedia: async (ctx) => {
      const prepared = await createDiscordOutboundSendContext(ctx);
      const { send, target } = prepared;
      const reply = prepared.resolveReply();
      if (ctx.audioAsVoice && ctx.mediaUrl) {
        return toDiscordOutboundDeliveryResult(
          await prepared.sendVoice(target, ctx.mediaUrl, prepared.voiceOptions(reply)),
        );
      }
      const options = prepared.options(reply);
      const mediaOptions = prepared.mediaOptions(ctx.mediaUrl, reply);
      const trimmed = ctx.text.trim() && ctx.mediaUrl?.trim();
      if (trimmed) {
        let path: string;
        try {
          const { pathname } = new URL(trimmed);
          path = pathname.slice(pathname.lastIndexOf("/") + 1);
          // Decode only the filename; malformed escapes in earlier path segments are irrelevant.
          try {
            path = decodeURIComponent(path);
          } catch {
            // A malformed escape leaves the original filename available for extension detection.
          }
        } catch {
          path = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
        }
        const normalized = normalizeLowercaseStringOrEmpty(path);
        if (DISCORD_VIDEO_MEDIA_EXTENSIONS.some((ext) => normalized.endsWith(ext))) {
          const captionResult = await send(target, ctx.text, options);
          // Forum sends create their thread on the first message; the video belongs in that thread.
          const mediaTarget = captionResult.receipt?.threadId
            ? `channel:${captionResult.receipt.threadId}`
            : target;
          const mediaResult = await send(mediaTarget, "", {
            ...mediaOptions,
            reply: options.reply?.scope === "all" ? options.reply : undefined,
          });
          const threadId = captionResult.receipt?.threadId;
          return toDiscordOutboundDeliveryResult({
            ...(threadId ? captionResult : mediaResult),
            receipt: createDiscordSendReceiptFromResults({
              results: [captionResult, mediaResult],
              threadId,
            }),
          });
        }
      }
      return toDiscordOutboundDeliveryResult(await send(target, ctx.text, mediaOptions));
    },
    sendPoll: async ({
      cfg,
      to,
      poll,
      content,
      accountId,
      threadId,
      silent,
      signal,
      sessionKey,
      inboundEventKind,
      onPlatformSendDispatch,
      assertDirectAdapterHandoff,
    }) => {
      if (!createDiscordActionGate({ cfg, accountId })("polls")) {
        throw new Error("Discord polls are disabled.");
      }
      const outboundTo = resolveDiscordAttachedOutboundTarget({ to, threadId });
      const result = await (
        await loadDiscordSendRuntime()
      ).sendPollDiscord(outboundTo, poll, {
        accountId: accountId ?? undefined,
        content,
        threadId: threadId ?? undefined,
        silent: silent ?? undefined,
        cfg,
        signal,
        onPlatformSendDispatch,
        assertPlatformSendAuthorized: assertDirectAdapterHandoff,
      });
      discordInboundEventDelivery.notify({
        sessionKey,
        inboundEventKind,
        to: outboundTo,
        accountId,
      });
      return result;
    },
  }),
  adoptTargetFromDelivery: ({ result }) => {
    const threadId = normalizeOptionalStringifiedId(result.receipt?.threadId);
    return threadId ? { threadId } : null;
  },
  afterDeliverPayload: async ({ cfg, target, payload, results }) => {
    notifyDiscordInboundEventOutboundPayloadSuccess({
      payload,
      to: resolveDiscordAttachedOutboundTarget({ to: target.to, threadId: target.threadId }),
      accountId: target.accountId,
    });
    const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
    const result = results.find(
      (candidate) => candidate.channel === "discord" && candidate.messageId,
    );
    const componentSpec = questionId ? await resolveDiscordComponentSpec(payload) : undefined;
    if (questionId && result && componentSpec) {
      const to = resolveDiscordAttachedOutboundTarget({ to: target.to, threadId: target.threadId });
      const channelId = result.target?.kind === "channel" ? result.target.id : to;
      questionGatewayRuntime.registerChannelDelivery({
        questionId,
        deliveryId: `discord:${target.accountId ?? "default"}:${channelId}:${result.messageId}`,
        finalize: async (statusLine) => {
          const { editDiscordComponentMessage } = await loadDiscordComponentSendRuntime();
          await editDiscordComponentMessage(
            to,
            result.messageId,
            {
              ...componentSpec,
              blocks: [
                ...(componentSpec.blocks ?? []).filter((block) => block.type !== "actions"),
                // Same markdown-inert display escaping approvals use; raw
                // option labels must not become live Discord markup/mentions.
                { type: "text", text: `-# ${formatDiscordApprovalDisplayValue(statusLine)}` },
              ],
              modal: undefined,
            },
            { cfg, accountId: target.accountId ?? undefined },
          );
        },
      });
    }
    const threadId = normalizeOptionalStringifiedId(target.threadId);
    if (!threadId) {
      return;
    }
    const { getThreadBindingManager } = await loadDiscordThreadBindings();
    const manager = getThreadBindingManager(target.accountId ?? undefined);
    if (!manager?.getByThreadId(threadId)) {
      return;
    }
    await manager.touchThread({ threadId });
  },
};
