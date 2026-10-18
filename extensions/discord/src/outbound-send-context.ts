import { createReplyToFanout, resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveDiscordAttachedOutboundTarget } from "./channel.conversation.js";
import { resolveDiscordReplyReference } from "./reply-reference.js";
import { toDiscordOutboundDeliveryResult } from "./send.receipt.js";
import type { DiscordSendResult } from "./send.types.js";

type DiscordSendRuntime = typeof import("./send.js");

type DiscordSendFn = DiscordSendRuntime["sendMessageDiscord"];
type DiscordVoiceSendFn = DiscordSendRuntime["sendVoiceMessageDiscord"];
type DiscordOutboundContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

export const loadDiscordSendRuntime = createLazyRuntimeModule(() => import("./send.js"));

export function resolveDiscordDeliveryOptions(ctx: DiscordOutboundContext) {
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

export async function createDiscordOutboundSendContext(ctx: DiscordOutboundContext) {
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
