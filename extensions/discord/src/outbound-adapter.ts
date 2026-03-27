import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveOutboundSendDep,
  type OutboundIdentity,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { DiscordComponentMessageSpec } from "./components.js";
import { getThreadBindingManager, type ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import {
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendWebhookMessageDiscord,
} from "./send.js";
import { buildDiscordInteractiveComponents } from "./shared-interactive.js";
import { parseDiscordTarget } from "./targets.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;

function resolveDiscordThreadDelivery(params: {
  to: string;
  threadId?: string | number | null;
  accountId?: string | null;
}): { target: string; binding?: ThreadBindingRecord; useThreadTarget: boolean } {
  if (params.threadId == null) {
    return { target: params.to, useThreadTarget: false };
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return { target: params.to, useThreadTarget: false };
  }
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  const binding = manager?.getByThreadId(threadId);
  if (!binding) {
    return { target: `channel:${threadId}`, useThreadTarget: true };
  }
  const parsedTarget = parseDiscordTarget(params.to, { defaultKind: "channel" });
  const targetChannelId = parsedTarget?.kind === "channel" ? parsedTarget.id : undefined;
  if (targetChannelId === threadId || targetChannelId === binding.channelId) {
    return { target: `channel:${threadId}`, binding, useThreadTarget: true };
  }
  return { target: params.to, binding, useThreadTarget: false };
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = params.identity?.name?.trim();
  const fallbackUsername = params.binding.label?.trim() || params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = params.identity?.avatarUrl?.trim() || undefined;
  return { username, avatarUrl };
}

async function maybeSendDiscordWebhookText(params: {
  cfg?: OpenClawConfig;
  to: string;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  const delivery = resolveDiscordThreadDelivery({
    to: params.to,
    threadId: params.threadId,
    accountId: params.accountId,
  });
  if (!delivery.useThreadTarget || !delivery.binding) {
    return null;
  }
  const binding = delivery.binding;
  if (!binding.webhookId || !binding.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    cfg: params.cfg,
    replyTo: params.replyToId ?? undefined,
    username: persona.username,
    avatarUrl: persona.avatarUrl,
  });
  return result;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendPayload: async (ctx) => {
    const payload = {
      ...ctx.payload,
      text: ctx.payload.text ?? "",
    };
    const discordData = payload.channelData?.discord as
      | { components?: DiscordComponentMessageSpec }
      | undefined;
    const rawComponentSpec =
      discordData?.components ?? buildDiscordInteractiveComponents(payload.interactive);
    const componentSpec = rawComponentSpec
      ? rawComponentSpec.text
        ? rawComponentSpec
        : {
            ...rawComponentSpec,
            text: payload.text?.trim() ? payload.text : undefined,
          }
      : undefined;
    if (!componentSpec) {
      return await sendTextMediaPayload({
        channel: "discord",
        ctx: {
          ...ctx,
          payload,
        },
        adapter: discordOutbound,
      });
    }
    const send =
      resolveOutboundSendDep<typeof sendMessageDiscord>(ctx.deps, "discord") ?? sendMessageDiscord;
    const target = resolveDiscordThreadDelivery({
      to: ctx.to,
      threadId: ctx.threadId,
      accountId: ctx.accountId,
    }).target;
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const result = await sendPayloadMediaSequenceOrFallback({
      text: payload.text ?? "",
      mediaUrls,
      fallbackResult: { messageId: "", channelId: target },
      sendNoMedia: async () =>
        await sendDiscordComponentMessage(target, componentSpec, {
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        }),
      send: async ({ text, mediaUrl, isFirst }) => {
        if (isFirst) {
          return await sendDiscordComponentMessage(target, componentSpec, {
            mediaUrl,
            mediaLocalRoots: ctx.mediaLocalRoots,
            replyTo: ctx.replyToId ?? undefined,
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
          });
        }
        return await send(target, text, {
          verbose: false,
          mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        });
      },
    });
    return attachChannelToResult("discord", result);
  },
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
      if (!silent) {
        const webhookResult = await maybeSendDiscordWebhookText({
          cfg,
          to,
          text,
          threadId,
          accountId,
          identity,
          replyToId,
        }).catch(() => null);
        if (webhookResult) {
          return webhookResult;
        }
      }
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(
        resolveDiscordThreadDelivery({
          to,
          threadId,
          accountId,
        }).target,
        text,
        {
          verbose: false,
          replyTo: replyToId ?? undefined,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
          cfg,
        },
      );
    },
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
    }) => {
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(
        resolveDiscordThreadDelivery({
          to,
          threadId,
          accountId,
        }).target,
        text,
        {
          verbose: false,
          mediaUrl,
          mediaLocalRoots,
          replyTo: replyToId ?? undefined,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
          cfg,
        },
      );
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) =>
      await sendPollDiscord(
        resolveDiscordThreadDelivery({
          to,
          threadId,
          accountId,
        }).target,
        poll,
        {
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
          cfg,
        },
      ),
  }),
};
