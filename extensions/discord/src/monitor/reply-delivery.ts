import { formatReasoningMessage, resolveAgentAvatar } from "openclaw/plugin-sdk/agent-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  buildOutboundSessionContext,
  listMessageReceiptPlatformIds,
  sendDurableMessageBatch,
  type OutboundIdentity,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  MarkdownTableMode,
  OpenClawConfig,
  ReplyToMode,
} from "openclaw/plugin-sdk/config-contracts";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { RequestClient } from "../internal/discord.js";
import { sendMessageDiscord, sendVoiceMessageDiscord } from "../send.js";
import type { DiscordAllowedMentions } from "../send.shared.js";
import { sanitizeDiscordFrontChannelReplyPayloads } from "./reply-safety.js";

type DiscordThreadBindingLookupRecord = {
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

export function formatDiscordReplyDeliveryFailure(params: {
  kind: string;
  err: unknown;
  target: string;
  sessionKey?: string;
}) {
  const context = [
    `target=${params.target}`,
    params.sessionKey ? `session=${params.sessionKey}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `discord ${params.kind} reply failed (${context}): ${String(params.err)}`;
}

type DiscordReplySkipReason = "aborted before delivery" | "internal-only payload";

export function formatDiscordReplySkip(params: {
  kind: "tool" | "block" | "final";
  reason: DiscordReplySkipReason;
  target: string;
  sessionKey?: string;
}) {
  const context = [
    `target=${params.target}`,
    params.sessionKey ? `session=${params.sessionKey}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `discord ${params.kind} reply skipped (${params.reason}): ${context}`;
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
  const targetChannelId = params.target.startsWith("channel:")
    ? params.target.slice("channel:".length).trim()
    : undefined;
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
  const displayName = `🤖 ${baseLabel}`.trim() || "🤖 agent";
  const identity: OutboundIdentity = {
    name: truncateUtf16Safe(displayName, 80),
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
  allowedMentions?: DiscordAllowedMentions;
}): OutboundSendDeps {
  return {
    // Discord webhooks default to user-only parsing; bot messages need this
    // explicit policy to prevent a fresh preview final from broadcasting.
    discord: (to: string, text: string, opts?: Parameters<typeof sendMessageDiscord>[2]) =>
      sendMessageDiscord(to, text, {
        ...opts,
        cfg: opts?.cfg ?? params.cfg,
        token: params.token,
        rest: params.rest,
        ...(params.allowedMentions ? { allowedMentions: params.allowedMentions } : {}),
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
  allowedMentions?: DiscordAllowedMentions;
  kind: "tool" | "block" | "final";
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
}) {
  void params.runtime;

  const binding = resolveBoundThreadBinding(params);
  const to = binding ? `channel:${binding.channelId}` : params.target;
  const payloads = sanitizeDiscordFrontChannelReplyPayloads(params.replies, {
    kind: params.kind,
  })
    .map(formatDiscordReasoningPayload)
    .map((payload) => params.bindPendingFinalDelivery?.(payload) ?? payload);
  if (payloads.length === 0) {
    return {
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" as const },
    };
  }

  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel: "discord",
    to,
    accountId: params.accountId,
    payloads,
    replyToId: normalizeOptionalString(params.replyToId),
    replyToMode: params.replyToMode ?? "all",
    formatting: {
      textLimit: params.textLimit,
      maxLinesPerMessage: params.maxLinesPerMessage,
      tableMode: params.tableMode,
      chunkMode: params.chunkMode,
    },
    threadId: binding?.threadId,
    identity: resolveBindingIdentity(params.cfg, binding),
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.assertPlatformSendAuthorized,
    deps: createDiscordDeliveryDeps({
      cfg: params.cfg,
      token: params.token,
      rest: params.rest,
      allowedMentions: params.allowedMentions,
    }),
    mediaAccess: params.mediaLocalRoots?.length
      ? { localRoots: params.mediaLocalRoots }
      : undefined,
    session: buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: binding?.agentId,
      requesterAccountId: params.accountId,
    }),
  });
  if (send.status === "failed") {
    throw send.error;
  }
  if (send.status === "suppressed") {
    const hookEffect = send.payloadOutcomes?.find(
      (outcome) => outcome.status === "suppressed",
    )?.hookEffect;
    return {
      visibleReplySent: false,
      suppression: {
        reason: send.reason,
        ...(hookEffect?.cancelReason ? { cancelReason: hookEffect.cancelReason } : {}),
        ...(hookEffect?.metadata ? { metadata: hookEffect.metadata } : {}),
      },
    };
  }
  if (send.results.length === 0) {
    throw new Error(`discord final reply produced no delivered message for ${to}`);
  }
  const deliveryResult = {
    messageIds: listMessageReceiptPlatformIds(send.receipt),
    receipt: send.receipt,
    visibleReplySent: true as const,
  };
  if (send.status === "partial_failed") {
    // Accepted receipts must survive failure so dispatch never replays visible chunks.
    throw createChannelPartialDeliveryError(send.error, deliveryResult);
  }
  return deliveryResult;
}
