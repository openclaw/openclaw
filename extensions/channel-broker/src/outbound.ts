import {
  BROKER_PROTOCOL_VERSION,
  brokerPlatformSupports,
  createBrokerOutboundRequest,
  normalizeBrokerPlatformId,
  type BrokerDeliveryRequirements,
  type BrokerMessageAttachment,
  type BrokerOutboundRequestV1,
  type BrokerOutboundPayload,
  type BrokerReceiptV1,
  type BrokerReceiptStatus,
} from "openclaw/plugin-sdk/channel-broker";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageSendResult,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-message";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveChannelBrokerAccount } from "./accounts.js";
import { createBrokerRequestId, sendBrokerOutboundRequest } from "./runtime.js";
import { parseChannelBrokerTarget } from "./target.js";
import type { CoreConfig, ResolvedChannelBrokerAccount } from "./types.js";

const CHANNEL_ID = "channel-broker" as const;
const BROKER_RECEIPT_STATUSES = new Set<BrokerReceiptStatus>([
  "sent",
  "suppressed",
  "failed",
  "retryable",
  "unsupported",
]);

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

function listUnsupportedDeliveryRequirements(params: {
  account: ResolvedChannelBrokerAccount;
  platform: string;
  requirements: BrokerDeliveryRequirements;
}): string[] {
  const platformCapabilities = params.account.capabilities[params.platform];
  if (!platformCapabilities) {
    return [];
  }
  if (!platformCapabilities.delivery) {
    return [];
  }
  if (
    brokerPlatformSupports({
      capabilities: {
        providerId: params.account.providerId,
        platforms: Object.values(params.account.capabilities),
      },
      platform: params.platform,
      requirements: { delivery: params.requirements },
    })
  ) {
    return [];
  }
  return Object.entries(params.requirements)
    .filter(([, required]) => required)
    .filter(
      ([key]) => platformCapabilities.delivery?.[key as keyof BrokerDeliveryRequirements] !== true,
    )
    .map(([key]) => key);
}

function assertProviderSupportsDeliveryRequirements(params: {
  account: ResolvedChannelBrokerAccount;
  platform: string;
  requirements: BrokerDeliveryRequirements;
}): void {
  const unsupported = listUnsupportedDeliveryRequirements(params);
  if (unsupported.length === 0) {
    return;
  }
  throw new Error(
    `Channel broker provider ${params.account.providerId} does not support ${params.platform} delivery requirements: ${unsupported.join(", ")}.`,
  );
}

function validateBrokerReceiptForRequest(
  receipt: BrokerReceiptV1,
  request: BrokerOutboundRequestV1,
): BrokerReceiptV1 {
  if (receipt.version !== BROKER_PROTOCOL_VERSION) {
    throw new Error(
      `Channel broker provider ${request.providerId} returned unsupported receipt version ${String(receipt.version)}.`,
    );
  }
  if (receipt.requestId !== request.requestId) {
    throw new Error(
      `Channel broker provider ${request.providerId} returned receipt for request ${receipt.requestId} while OpenClaw expected ${request.requestId}.`,
    );
  }
  if (receipt.providerId !== request.providerId) {
    throw new Error(
      `Channel broker receipt provider mismatch: expected ${request.providerId}, got ${receipt.providerId}.`,
    );
  }
  const platform = normalizeBrokerPlatformId(receipt.platform);
  if (platform !== request.platform) {
    throw new Error(
      `Channel broker receipt platform mismatch: expected ${request.platform}, got ${platform}.`,
    );
  }
  if (!BROKER_RECEIPT_STATUSES.has(receipt.status)) {
    throw new Error(
      `Channel broker provider ${request.providerId} returned invalid receipt status ${receipt.status}.`,
    );
  }
  if (!Array.isArray(receipt.messageIds)) {
    throw new Error(`Channel broker provider ${request.providerId} returned invalid message ids.`);
  }
  return {
    ...receipt,
    platform,
    messageIds: receipt.messageIds.map((messageId) => messageId.trim()).filter(Boolean),
  };
}

async function sendChannelBrokerFinal(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  payloads: BrokerOutboundPayload[];
  requirements: BrokerDeliveryRequirements;
  receiptKind: "text" | "media" | "voice";
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
  const requirements = {
    ...params.requirements,
    ...(replyToId ? { replyTo: true } : {}),
    ...(threadId ? { thread: true } : {}),
    ...(params.silent ? { silent: true } : {}),
  } satisfies BrokerDeliveryRequirements;
  assertProviderSupportsDeliveryRequirements({
    account,
    platform: target.platform,
    requirements,
  });
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
    requirements,
  });
  const receipt = validateBrokerReceiptForRequest(
    await sendBrokerOutboundRequest({
      account,
      request,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
    request,
  );
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
  mediaAccess?: ChannelOutboundContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
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
  const mediaType = params.audioAsVoice ? "voice" : "media";
  const attachment: BrokerMessageAttachment = /^https?:\/\//i.test(url)
    ? { url, mediaType }
    : await createInlineBrokerMediaAttachment({
        mediaUrl: url,
        mediaType,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      });
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
    receiptKind: params.audioAsVoice ? "voice" : "media",
  });
}

async function createInlineBrokerMediaAttachment(params: {
  mediaUrl: string;
  mediaType: string;
  mediaAccess?: ChannelOutboundContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<BrokerMessageAttachment> {
  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  return {
    mediaType: params.mediaType,
    contentBase64: media.buffer.toString("base64"),
    sizeBytes: media.buffer.byteLength,
    ...(media.contentType ? { mimeType: media.contentType } : {}),
    ...(media.fileName ? { name: media.fileName } : {}),
  };
}

export async function sendChannelBrokerOutboundText(
  ctx: ChannelOutboundContext,
): Promise<{ messageId: string }> {
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
  return { messageId: result.messageId ?? "" };
}

export async function sendChannelBrokerOutboundMedia(
  ctx: ChannelOutboundContext,
): Promise<{ messageId: string }> {
  const signal = (ctx as ChannelOutboundContext & { signal?: AbortSignal }).signal;
  if (!ctx.mediaUrl) {
    throw new Error("Channel broker outbound media send requires a media URL.");
  }
  const result = await sendChannelBrokerMedia({
    cfg: ctx.cfg as CoreConfig,
    accountId: ctx.accountId,
    to: ctx.to,
    text: ctx.text,
    mediaUrl: ctx.mediaUrl,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    threadId: ctx.threadId,
    replyToId: ctx.replyToId,
    silent: ctx.silent,
    audioAsVoice: ctx.audioAsVoice,
    ...(signal ? { signal } : {}),
  });
  return { messageId: result.messageId ?? "" };
}
