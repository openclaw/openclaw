import {
  createBrokerOutboundRequest,
  type BrokerMessageAttachment,
  type BrokerOutboundPayload,
  type BrokerReceiptV1,
} from "openclaw/plugin-sdk/channel-broker";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageSendResult,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-message";
import { resolveChannelBrokerAccount } from "./accounts.js";
import { createBrokerRequestId, sendBrokerOutboundRequest } from "./runtime.js";
import { parseChannelBrokerTarget } from "./target.js";
import type { CoreConfig } from "./types.js";

const CHANNEL_ID = "channel-broker" as const;

export class ChannelBrokerProviderReceiptError extends Error {
  readonly receipt: BrokerReceiptV1;

  constructor(receipt: BrokerReceiptV1) {
    const providerMessage = receipt.error?.message?.trim();
    const retryAfter = receipt.retryAfterMs ? ` retryAfterMs=${receipt.retryAfterMs}` : "";
    super(
      `Channel broker provider ${receipt.providerId} returned ${receipt.status} receipt for request ${receipt.requestId}${providerMessage ? `: ${providerMessage}` : ""}${retryAfter}.`,
    );
    this.name = "ChannelBrokerProviderReceiptError";
    this.receipt = receipt;
  }
}

function normalizeMaybeString(value: string | number | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed || undefined;
}

function assertProviderReceiptSent(receipt: BrokerReceiptV1): void {
  if (receipt.status === "sent") {
    return;
  }
  throw new ChannelBrokerProviderReceiptError(receipt);
}

function resolvePrimaryMessageId(receipt: BrokerReceiptV1): string {
  assertProviderReceiptSent(receipt);
  const messageId = receipt.messageIds[0]?.trim();
  if (!messageId) {
    throw new Error(`Channel broker provider ${receipt.providerId} did not return a message id.`);
  }
  return messageId;
}

function buildReceiptSourceResults(params: {
  receipt: BrokerReceiptV1;
  conversationId: string;
}): MessageReceiptSourceResult[] {
  const { receipt } = params;
  const timestamp = receipt.timestamp ?? Date.now();
  return receipt.messageIds.map((messageId) => ({
    channel: CHANNEL_ID,
    messageId,
    conversationId: params.conversationId,
    timestamp,
    meta: {
      providerId: receipt.providerId,
      platform: receipt.platform,
      status: receipt.status,
      requestId: receipt.requestId,
      ...(receipt.native ? { native: receipt.native } : {}),
    },
  }));
}

async function sendChannelBrokerFinal(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  payloads: BrokerOutboundPayload[];
  requirements: {
    text?: boolean;
    media?: boolean;
    replyTo?: boolean;
    thread?: boolean;
    silent?: boolean;
  };
  receiptKind: "text" | "media";
  threadId?: string | number | null;
  replyToId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
}): Promise<ChannelMessageSendResult> {
  const account = resolveChannelBrokerAccount({ cfg: params.cfg, accountId: params.accountId });
  const target = parseChannelBrokerTarget({
    rawTarget: params.to,
    account,
    threadId: params.threadId,
  });
  const threadId = normalizeMaybeString(target.threadId);
  const replyToId = normalizeMaybeString(params.replyToId);
  const request = createBrokerOutboundRequest({
    requestId: createBrokerRequestId(),
    providerId: account.providerId,
    platform: target.platform,
    accountId: account.accountId,
    conversation: {
      id: target.conversationId,
      type: target.conversationType ?? account.defaultConversationType,
      ...(threadId ? { threadId } : {}),
    },
    mode: "final",
    payloads: params.payloads,
    ...(replyToId || params.silent
      ? {
          relation: {
            ...(replyToId ? { replyToId } : {}),
            ...(params.silent ? { silent: true } : {}),
          },
        }
      : {}),
    requirements: {
      ...params.requirements,
      ...(replyToId ? { replyTo: true } : {}),
      ...(threadId ? { thread: true } : {}),
      ...(params.silent ? { silent: true } : {}),
    },
  });
  const receipt = await sendBrokerOutboundRequest({
    account,
    request,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const messageId = resolvePrimaryMessageId(receipt);
  return {
    messageId,
    receipt: {
      ...createMessageReceiptFromOutboundResults({
        results: buildReceiptSourceResults({
          receipt,
          conversationId: target.conversationId,
        }),
        threadId,
        replyToId,
        kind: params.receiptKind,
        sentAt: receipt.timestamp,
      }),
      ...(receipt.editToken ? { editToken: receipt.editToken } : {}),
      ...(receipt.deleteToken ? { deleteToken: receipt.deleteToken } : {}),
    },
  };
}

export async function sendChannelBrokerText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
}): Promise<ChannelMessageSendResult> {
  return await sendChannelBrokerFinal({
    ...params,
    payloads: [{ text: params.text }],
    requirements: { text: true },
    receiptKind: "text",
  });
}

export async function sendChannelBrokerMedia(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text?: string | null;
  mediaUrl: string;
  audioAsVoice?: boolean;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
}): Promise<ChannelMessageSendResult> {
  const url = params.mediaUrl.trim();
  if (!url) {
    throw new Error("Channel broker media send requires a media URL.");
  }
  const attachment: BrokerMessageAttachment = {
    url,
    mediaType: params.audioAsVoice ? "voice" : "media",
  };
  const text = params.text?.trim();
  return await sendChannelBrokerFinal({
    ...params,
    payloads: [
      {
        ...(text ? { text } : {}),
        attachments: [attachment],
      },
    ],
    requirements: {
      media: true,
      ...(text ? { text: true } : {}),
    },
    receiptKind: "media",
  });
}

export async function sendChannelBrokerOutboundText(
  ctx: ChannelOutboundContext,
): Promise<{ ok: boolean; messageId: string; error?: Error }> {
  try {
    const signal = (ctx as ChannelOutboundContext & { signal?: AbortSignal }).signal;
    const result = await sendChannelBrokerText({
      cfg: ctx.cfg as CoreConfig,
      accountId: ctx.accountId,
      to: ctx.to,
      text: ctx.text,
      threadId: ctx.threadId,
      replyToId: ctx.replyToId,
      silent: ctx.silent,
      ...(signal ? { signal } : {}),
    });
    return { ok: true, messageId: result.messageId ?? "" };
  } catch (error) {
    return {
      ok: false,
      messageId: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
