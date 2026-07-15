import { createHash } from "node:crypto";
import type { AgentMailClient } from "agentmail";
import type {
  ChannelMessageSendPayloadContext,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveAgentMailAccount } from "./accounts.js";
import { createAgentMailClient } from "./client.js";
import { loadAgentMailOutboundAttachments } from "./media.js";

const TARGET_PREFIX = "message:";

export function normalizeAgentMailTarget(value: string | null | undefined): string | null {
  const target = value?.trim();
  if (!target?.startsWith(TARGET_PREFIX)) {
    return null;
  }
  const messageId = target.slice(TARGET_PREFIX.length).trim();
  const invalid = [...messageId].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character.trim() === "" || code <= 31 || code === 127;
  });
  return messageId && !invalid ? `${TARGET_PREFIX}${messageId}` : null;
}

export function parseAgentMailMessageTarget(value: string): string {
  const normalized = normalizeAgentMailTarget(value);
  if (!normalized) {
    throw new Error(
      "AgentMail target must be message:<messageId>; new threads and recipients are not supported.",
    );
  }
  return normalized.slice(TARGET_PREFIX.length);
}

function idempotencyKey(queueId: string): string {
  const hash = createHash("sha256").update(`agentmail-reply\n${queueId}`).digest("hex");
  return `openclaw-agentmail-${hash}`;
}

type AgentMailSendContext = Pick<
  ChannelMessageSendTextContext,
  | "cfg"
  | "to"
  | "text"
  | "accountId"
  | "replyToId"
  | "replyToIdSource"
  | "deliveryQueueId"
  | "onPlatformSendDispatch"
> &
  Partial<
    Pick<
      ChannelMessageSendPayloadContext,
      "payload" | "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
    >
  >;

function assertTriggeringMessageBoundary(
  ctx: Pick<AgentMailSendContext, "replyToId" | "replyToIdSource">,
  triggeringMessageId: string,
): void {
  if (ctx.replyToIdSource !== "implicit" || ctx.replyToId !== triggeringMessageId) {
    throw new Error(
      "AgentMail replies must remain bound to the triggering message for the active inbound turn.",
    );
  }
}

function collectMediaUrls(ctx: AgentMailSendContext): string[] {
  if (!ctx.payload) {
    return [];
  }
  return [
    ...new Set(
      [ctx.mediaUrl, ctx.payload.mediaUrl, ...(ctx.payload.mediaUrls ?? [])].filter(Boolean),
    ),
  ] as string[];
}

async function sendBoundAgentMailReply(
  ctx: AgentMailSendContext,
  triggeringMessageId: string,
  options: { client?: AgentMailClient },
) {
  const account = resolveAgentMailAccount(ctx.cfg, ctx.accountId);
  if (!ctx.deliveryQueueId) {
    throw new Error("AgentMail replies require a durable OpenClaw delivery queue ID.");
  }
  const mediaUrls = collectMediaUrls(ctx);
  const attachments = await loadAgentMailOutboundAttachments({
    mediaUrls,
    maxBytes: account.mediaMaxBytes,
    ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
    ...(ctx.mediaLocalRoots ? { mediaLocalRoots: ctx.mediaLocalRoots } : {}),
    ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
  });
  const text = (ctx.payload?.text ?? ctx.text)?.trim() || undefined;
  if (!text && attachments.length === 0) {
    throw new Error("AgentMail reply must contain text or at least one attachment.");
  }
  await ctx.onPlatformSendDispatch?.();
  const client = options.client ?? createAgentMailClient(account);
  const result = await client.inboxes.messages.reply(
    account.inboxId,
    triggeringMessageId,
    {
      ...(text ? { text } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      replyAll: false,
    },
    { idempotencyKey: idempotencyKey(ctx.deliveryQueueId) },
  );
  return {
    channel: "agentmail" as const,
    messageId: result.messageId,
    chatId: result.threadId,
    receipt: {
      primaryPlatformMessageId: result.messageId,
      platformMessageIds: [result.messageId],
      parts: [
        {
          platformMessageId: result.messageId,
          kind: attachments.length > 0 ? ("media" as const) : ("text" as const),
          index: 0,
          threadId: result.threadId,
          replyToId: triggeringMessageId,
        },
      ],
      threadId: result.threadId,
      replyToId: triggeringMessageId,
      sentAt: Date.now(),
    },
  };
}

export async function sendAgentMailReply(
  ctx: AgentMailSendContext,
  options: { client?: AgentMailClient } = {},
) {
  const triggeringMessageId = parseAgentMailMessageTarget(ctx.to);
  assertTriggeringMessageBoundary(ctx, triggeringMessageId);
  return await sendBoundAgentMailReply(ctx, triggeringMessageId, options);
}

/**
 * Repeats an uncertain reply with the same queue-derived AgentMail idempotency key. AgentMail
 * returns the original reply for a committed key, so this both reconciles and completes recovery.
 */
export async function reconcileAgentMailUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
  options: { client?: AgentMailClient } = {},
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  if (ctx.payloads.length !== 1 || (ctx.renderedBatchPlan?.items.length ?? 1) !== 1) {
    return {
      status: "unresolved",
      error: "AgentMail reconciliation requires exactly one atomic reply payload",
      retryable: false,
    };
  }
  const payload = ctx.payloads[0];
  if (!payload) {
    return { status: "not_sent" };
  }
  const rendered = ctx.renderedBatchPlan?.items[0];
  const triggeringMessageId = parseAgentMailMessageTarget(ctx.to);
  if (ctx.effectiveReplyToId !== triggeringMessageId) {
    return {
      status: "unresolved",
      error: "AgentMail recovery target is not bound to its triggering message",
      retryable: false,
    };
  }
  const mediaUrls = rendered?.mediaUrls.length
    ? [...rendered.mediaUrls]
    : [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter((value): value is string =>
        Boolean(value),
      );
  const text = rendered?.text ?? payload.text ?? "";
  const result = await sendBoundAgentMailReply(
    {
      cfg: ctx.cfg,
      to: ctx.to,
      text,
      accountId: ctx.accountId,
      deliveryQueueId: ctx.queueId,
      payload: {
        ...payload,
        text,
        ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
      },
    },
    triggeringMessageId,
    options,
  );
  return { status: "sent", messageId: result.messageId, receipt: result.receipt };
}
