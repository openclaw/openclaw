import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import {
  resolveAgentOutboundIdentity,
  resolveOutboundSendDep,
  type OutboundIdentity,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import type { DiscordComponentMessageSpec } from "./components.js";
import type { ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { resolveThreadBindingPersonaFromRecord } from "./monitor/thread-bindings.persona.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;

type DiscordSendRuntime = typeof import("./send.js");
type DiscordSendFn = DiscordSendRuntime["sendMessageDiscord"];
type DiscordComponentSendFn = typeof import("./send.components.js").sendDiscordComponentMessage;
type DiscordSharedInteractiveModule = typeof import("./shared-interactive.js");
type DiscordThreadBindingsModule = typeof import("./monitor/thread-bindings.js");

let discordSendRuntimePromise: Promise<DiscordSendRuntime> | undefined;
let discordComponentSendPromise: Promise<DiscordComponentSendFn> | undefined;
let discordSharedInteractivePromise: Promise<DiscordSharedInteractiveModule> | undefined;
let discordThreadBindingsPromise: Promise<DiscordThreadBindingsModule> | undefined;

async function loadDiscordSendRuntime(): Promise<DiscordSendRuntime> {
  discordSendRuntimePromise ??= import("./send.js");
  return await discordSendRuntimePromise;
}

async function sendDiscordComponentMessageLazy(
  ...args: Parameters<DiscordComponentSendFn>
): ReturnType<DiscordComponentSendFn> {
  discordComponentSendPromise ??= import("./send.components.js").then(
    (module) => module.sendDiscordComponentMessage,
  );
  return await (
    await discordComponentSendPromise
  )(...args);
}

function loadDiscordSharedInteractive(): Promise<DiscordSharedInteractiveModule> {
  discordSharedInteractivePromise ??= import("./shared-interactive.js");
  return discordSharedInteractivePromise;
}

function loadDiscordThreadBindings(): Promise<DiscordThreadBindingsModule> {
  discordThreadBindingsPromise ??= import("./monitor/thread-bindings.js");
  return discordThreadBindingsPromise;
}

const outboundLog = createSubsystemLogger("discord/outbound-adapter");

function hasApprovalChannelData(payload: { channelData?: unknown }): boolean {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return false;
  }
  return Boolean((channelData as { execApproval?: unknown }).execApproval);
}

function neutralizeDiscordApprovalMentions(value: string): string {
  return value
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@/g, "<@\u200b")
    .replace(/<#/g, "<#\u200b");
}

function normalizeDiscordApprovalPayload<T extends { text?: string; channelData?: unknown }>(
  payload: T,
): T {
  return hasApprovalChannelData(payload) && payload.text
    ? {
        ...payload,
        text: neutralizeDiscordApprovalMentions(payload.text),
      }
    : payload;
}

function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

// F5b (Phase 10 Discord Surface Overhaul): unified persona resolution across
// outbound-adapter / reply-delivery / thread-bindings-persona. When cfg has
// `agents.<id>.identity` (emoji + name), use that as the username source so
// the webhook identity matches the intro banner (`⚙ claude` / `⚙ codex`)
// instead of regressing to the raw binding label.
//
// G4 (R2 fix): the direct-POST path (sendMessage -> maybeSendDiscordWebhookText)
// must produce the IDENTICAL username string as the session-active banner
// path (maybeSendBindingMessage). The banner path runs through
// resolveThreadBindingPersonaFromRecord which always emits a SYSTEM_MARK-
// prefixed string ("⚙ claude", etc) even when cfg identity is missing.
// Delegating here keeps both paths byte-identical so final_reply no longer
// regresses to the raw bot identity when Discord rejects a bare label.
function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
  cfg?: OpenClawConfig;
}): { username?: string; avatarUrl?: string } {
  const cfgIdentity =
    params.cfg && params.binding.agentId
      ? (() => {
          try {
            return resolveAgentOutboundIdentity(params.cfg, params.binding.agentId);
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const explicitName = normalizeOptionalString(params.identity?.name);
  const unifiedUsername = resolveThreadBindingPersonaFromRecord(params.binding, params.cfg);
  const username = ((explicitName ?? unifiedUsername) || "").slice(0, 80) || undefined;
  const avatarUrl =
    normalizeOptionalString(params.identity?.avatarUrl) ??
    normalizeOptionalString(cfgIdentity?.avatarUrl);
  return { username, avatarUrl };
}

// G5c (R2 fix, Phase 10 Discord Surface Overhaul): also consumed by the
// production `createChatChannelPlugin` outbound in `channel.ts`. Keep this
// export stable — channel.ts threads webhook-first delivery through this
// helper so bot-path fallback and webhook identity stay in lockstep across
// both the test-only `discordOutbound` adapter and the live plugin outbound.
export async function maybeSendDiscordWebhookText(params: {
  cfg?: OpenClawConfig;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return null;
  }
  const { getThreadBindingManager } = await loadDiscordThreadBindings();
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
    cfg: params.cfg,
  });
  const { sendWebhookMessageDiscord } = await loadDiscordSendRuntime();
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
  normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendPayload: async (ctx) => {
    const payload = normalizeDiscordApprovalPayload({
      ...ctx.payload,
      text: ctx.payload.text ?? "",
    });
    const discordData = payload.channelData?.discord as
      | { components?: DiscordComponentMessageSpec }
      | undefined;
    const rawComponentSpec =
      discordData?.components ??
      (payload.interactive
        ? (await loadDiscordSharedInteractive()).buildDiscordInteractiveComponents(
            payload.interactive,
          )
        : undefined);
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
      resolveOutboundSendDep<DiscordSendFn>(ctx.deps, "discord") ??
      (await loadDiscordSendRuntime()).sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to: ctx.to, threadId: ctx.threadId });
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const result = await sendPayloadMediaSequenceOrFallback({
      text: payload.text ?? "",
      mediaUrls,
      fallbackResult: { messageId: "", channelId: target },
      sendNoMedia: async () =>
        await sendDiscordComponentMessageLazy(target, componentSpec, {
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        }),
      send: async ({ text, mediaUrl, isFirst }) => {
        if (isFirst) {
          return await sendDiscordComponentMessageLazy(target, componentSpec, {
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: ctx.replyToId ?? undefined,
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
          });
        }
        return await send(target, text, {
          verbose: false,
          mediaUrl,
          mediaAccess: ctx.mediaAccess,
          mediaLocalRoots: ctx.mediaLocalRoots,
          mediaReadFile: ctx.mediaReadFile,
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
        // F6: preserve availability (fall back to bot) but surface the failure
        // at warn level so operators can see username-policy rejections or
        // other webhook errors. `fallbackUsed` flag is recorded for auditing.
        const webhookResult = await maybeSendDiscordWebhookText({
          cfg,
          text,
          threadId,
          accountId,
          identity,
          replyToId,
        }).catch((err: unknown) => {
          outboundLog.warn("webhook send failed, falling back to bot", {
            threadId,
            accountId,
            fallbackUsed: true,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        if (webhookResult) {
          return webhookResult;
        }
      }
      const send =
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        (await loadDiscordSendRuntime()).sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ to, threadId }), text, {
        verbose: false,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      });
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
      replyToId,
      threadId,
      silent,
    }) => {
      const send =
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        (await loadDiscordSendRuntime()).sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ to, threadId }), text, {
        verbose: false,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      });
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) =>
      await (
        await loadDiscordSendRuntime()
      ).sendPollDiscord(resolveDiscordOutboundTarget({ to, threadId }), poll, {
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      }),
  }),
};
