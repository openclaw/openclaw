// Discord plugin module implements reply delivery behavior.
import { formatReasoningMessage, resolveAgentAvatar } from "openclaw/plugin-sdk/agent-runtime";
import {
  buildOutboundSessionContext,
  sendDurableMessageBatch,
  type OutboundDeliveryFormattingOptions,
  type OutboundIdentity,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  MarkdownTableMode,
  OpenClawConfig,
  ReplyToMode,
} from "openclaw/plugin-sdk/config-contracts";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RequestClient } from "../internal/discord.js";
import { sendMessageDiscord, sendVoiceMessageDiscord } from "../send.js";
import { sanitizeDiscordFrontChannelReplyPayloads } from "./reply-safety.js";

const DISCORD_ATTACHMENT_TOO_LARGE_NOTICE =
  "⚠️ Attachment omitted because it exceeds Discord upload limits.";

function hasOversizedAttachmentError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; message?: unknown; cause?: unknown };
    if (record.status === 413) {
      return true;
    }
    const message =
      typeof record.message === "string"
        ? record.message.toLowerCase()
        : current instanceof Error
          ? current.message.toLowerCase()
          : "";
    if (
      message.includes("request entity too large") ||
      (message.includes("payload") && message.includes("too large")) ||
      (message.includes("attachment") && message.includes("too large")) ||
      (message.includes("413") && message.includes("too large"))
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

function appendAttachmentTooLargeNotice(text: string): string {
  if (text.includes(DISCORD_ATTACHMENT_TOO_LARGE_NOTICE)) {
    return text;
  }
  return `${text}\n${DISCORD_ATTACHMENT_TOO_LARGE_NOTICE}`;
}

function stripMediaForOversizedAttachmentFallback(payloads: ReplyPayload[]): ReplyPayload[] {
  const fallback: ReplyPayload[] = [];
  let emittedStandaloneNotice = false;
  for (const payload of payloads) {
    const hasMedia = Boolean(
      payload.mediaUrl?.trim() || payload.mediaUrls?.some((url) => url?.trim()),
    );
    if (!hasMedia) {
      fallback.push(payload);
      continue;
    }
    const text = payload.text?.trim();
    if (text) {
      fallback.push({
        ...payload,
        text: appendAttachmentTooLargeNotice(payload.text ?? ""),
        mediaUrl: undefined,
        mediaUrls: undefined,
        ttsSupplement: undefined,
      });
      continue;
    }
    if (!emittedStandaloneNotice) {
      fallback.push({ text: DISCORD_ATTACHMENT_TOO_LARGE_NOTICE, isError: true });
      emittedStandaloneNotice = true;
    }
  }
  return fallback;
}

export type DiscordThreadBindingLookupRecord = {
  accountId: string;
  channelId: string;
  threadId: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
};

export type DiscordThreadBindingLookup = {
  listBySessionKey: (targetSessionKey: string) => DiscordThreadBindingLookupRecord[];
  touchThread?: (params: { threadId: string; at?: number; persist?: boolean }) => unknown;
};

function resolveTargetChannelId(target: string): string | undefined {
  if (!target.startsWith("channel:")) {
    return undefined;
  }
  const channelId = target.slice("channel:".length).trim();
  return channelId || undefined;
}

function resolveBoundThreadBinding(params: {
  threadBindings?: DiscordThreadBindingLookup;
  sessionKey?: string;
  target: string;
}): DiscordThreadBindingLookupRecord | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.threadBindings || !sessionKey) {
    return undefined;
  }
  const targetChannelId = resolveTargetChannelId(params.target);
  if (!targetChannelId) {
    return undefined;
  }
  return params.threadBindings
    .listBySessionKey(sessionKey)
    .find((entry) => entry.threadId === targetChannelId);
}

function resolveBindingIdentity(
  cfg: OpenClawConfig,
  binding: DiscordThreadBindingLookupRecord | undefined,
): OutboundIdentity | undefined {
  if (!binding) {
    return undefined;
  }
  const baseLabel = binding.label?.trim() || binding.agentId;
  const identity: OutboundIdentity = {
    name: (`🤖 ${baseLabel}`.trim() || "🤖 agent").slice(0, 80),
  };
  try {
    const avatar = resolveAgentAvatar(cfg, binding.agentId);
    if (avatar.kind === "remote") {
      identity.avatarUrl = avatar.url;
    }
  } catch {
    // Avatar is cosmetic; delivery should not depend on local identity config.
  }
  return identity;
}

function createDiscordDeliveryDeps(params: {
  cfg: OpenClawConfig;
  token: string;
  rest?: RequestClient;
}): OutboundSendDeps {
  return {
    discord: (to: string, text: string, opts?: Parameters<typeof sendMessageDiscord>[2]) =>
      sendMessageDiscord(to, text, {
        ...opts,
        cfg: opts?.cfg ?? params.cfg,
        token: params.token,
        rest: params.rest,
      }),
    discordVoice: (
      to: string,
      audioPath: string,
      opts?: Parameters<typeof sendVoiceMessageDiscord>[2],
    ) =>
      sendVoiceMessageDiscord(to, audioPath, {
        ...opts,
        cfg: opts?.cfg ?? params.cfg,
        token: params.token,
        rest: params.rest,
      }),
  };
}

type DiscordDeliveryOptions = {
  to: string;
  threadId?: string;
  agentId?: string;
  identity?: OutboundIdentity;
  mediaAccess?: OutboundMediaAccess;
  replyToMode: ReplyToMode;
  formatting: OutboundDeliveryFormattingOptions;
};

function resolveDiscordDeliveryOptions(params: {
  cfg: OpenClawConfig;
  target: string;
  sessionKey?: string;
  threadBindings?: DiscordThreadBindingLookup;
  textLimit: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  replyToMode?: ReplyToMode;
  mediaLocalRoots?: readonly string[];
}): DiscordDeliveryOptions {
  const binding = resolveBoundThreadBinding({
    threadBindings: params.threadBindings,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  return {
    to: binding ? `channel:${binding.channelId}` : params.target,
    threadId: binding?.threadId,
    agentId: binding?.agentId,
    identity: resolveBindingIdentity(params.cfg, binding),
    mediaAccess: params.mediaLocalRoots?.length
      ? { localRoots: params.mediaLocalRoots }
      : undefined,
    replyToMode: params.replyToMode ?? "all",
    formatting: {
      textLimit: params.textLimit,
      maxLinesPerMessage: params.maxLinesPerMessage,
      tableMode: params.tableMode,
      chunkMode: params.chunkMode,
    },
  };
}

function formatDiscordReasoningPayload(payload: ReplyPayload): ReplyPayload {
  if (payload.isReasoning !== true) {
    return payload;
  }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const nextPayload: ReplyPayload = {
    ...payload,
    text: formatReasoningMessage(text),
  };
  delete nextPayload.isReasoning;
  return nextPayload;
}

export async function deliverDiscordReply(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  replyToMode?: ReplyToMode;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  sessionKey?: string;
  threadBindings?: DiscordThreadBindingLookup;
  mediaLocalRoots?: readonly string[];
  kind: "tool" | "block" | "final";
}) {
  void params.runtime;

  const delivery = resolveDiscordDeliveryOptions(params);
  const payloads = sanitizeDiscordFrontChannelReplyPayloads(params.replies, {
    kind: params.kind,
  }).map(formatDiscordReasoningPayload);
  if (payloads.length === 0) {
    return;
  }

  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel: "discord",
    to: delivery.to,
    accountId: params.accountId,
    payloads,
    replyToId: normalizeOptionalString(params.replyToId),
    replyToMode: delivery.replyToMode,
    formatting: delivery.formatting,
    threadId: delivery.threadId,
    identity: delivery.identity,
    deps: createDiscordDeliveryDeps({
      cfg: params.cfg,
      token: params.token,
      rest: params.rest,
    }),
    mediaAccess: delivery.mediaAccess,
    session: buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: delivery.agentId,
      requesterAccountId: params.accountId,
    }),
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    const hasDeliveredResults = send.status === "partial_failed" && send.results.length > 0;
    if (
      params.kind === "final" &&
      !hasDeliveredResults &&
      hasOversizedAttachmentError(send.error)
    ) {
      const fallbackPayloads = stripMediaForOversizedAttachmentFallback(payloads);
      if (fallbackPayloads.length > 0) {
        const fallbackSend = await sendDurableMessageBatch({
          cfg: params.cfg,
          channel: "discord",
          to: delivery.to,
          accountId: params.accountId,
          payloads: fallbackPayloads,
          replyToId: normalizeOptionalString(params.replyToId),
          replyToMode: delivery.replyToMode,
          formatting: delivery.formatting,
          threadId: delivery.threadId,
          identity: delivery.identity,
          deps: createDiscordDeliveryDeps({
            cfg: params.cfg,
            token: params.token,
            rest: params.rest,
          }),
          mediaAccess: delivery.mediaAccess,
          session: buildOutboundSessionContext({
            cfg: params.cfg,
            sessionKey: params.sessionKey,
            agentId: delivery.agentId,
            requesterAccountId: params.accountId,
          }),
        });
        if (fallbackSend.status === "failed" || fallbackSend.status === "partial_failed") {
          throw fallbackSend.error;
        }
        return;
      }
    }
    throw send.error;
  }
  const results = send.status === "sent" ? send.results : [];
  if (results.length === 0) {
    throw new Error(`discord final reply produced no delivered message for ${delivery.to}`);
  }
}
