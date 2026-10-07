import { createHash } from "node:crypto";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient, type ClickClackClient } from "./http-client.js";
import { resolveChannelId, resolveWorkspaceId } from "./resolve.js";
import { parseClickClackTarget } from "./target.js";
import type { ClickClackMessage, ClickClackMessageProvenance, CoreConfig } from "./types.js";

const CLICKCLACK_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

async function createTargetMessage(params: {
  client: ClickClackClient;
  workspaceId: string;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  provenance?: ClickClackMessageProvenance;
  nonce?: string;
  onPlatformSendDispatch?: () => Promise<void>;
  assertDirectAdapterHandoff?: () => void;
}): Promise<ClickClackMessage> {
  const parsed = parseClickClackTarget(params.to);
  const explicitThreadId = params.threadId == null ? "" : String(params.threadId);
  const replyToId = params.replyToId == null ? "" : String(params.replyToId);
  if (explicitThreadId || parsed.kind === "thread") {
    // Genuine thread context stays in that thread. A bare reply to a top-level
    // message remains a quote-reply so it does not silently leave the timeline.
    const rootId = explicitThreadId || parsed.id;
    params.assertDirectAdapterHandoff?.();
    await params.onPlatformSendDispatch?.();
    return await params.client.createThreadReply(rootId, params.text, {
      provenance: params.provenance,
      nonce: params.nonce,
    });
  }
  if (parsed.kind === "dm") {
    const dm = await params.client.createDirectConversation(params.workspaceId, [parsed.id]);
    params.assertDirectAdapterHandoff?.();
    await params.onPlatformSendDispatch?.();
    return await params.client.createDirectMessage(dm.id, params.text, {
      quotedMessageId: replyToId || undefined,
      nonce: params.nonce,
    });
  }
  const channelId = await resolveChannelId(params.client, params.workspaceId, parsed.id);
  params.assertDirectAdapterHandoff?.();
  await params.onPlatformSendDispatch?.();
  return await params.client.createChannelMessage(channelId, params.text, {
    provenance: params.provenance,
    quotedMessageId: replyToId || undefined,
    nonce: params.nonce,
  });
}

function durableDeliveryDigest(params: {
  deliveryQueueId?: string;
  deliveryPartIndex?: number;
}): string | undefined {
  if (!params.deliveryQueueId) {
    return undefined;
  }
  if (!Number.isSafeInteger(params.deliveryPartIndex) || (params.deliveryPartIndex ?? -1) < 0) {
    throw new Error("ClickClack durable delivery requires a stable delivery part index");
  }
  return createHash("sha256")
    .update(`${params.deliveryQueueId}\n${params.deliveryPartIndex}`)
    .digest("hex");
}

function mediaDeliveryNonces(params: Parameters<typeof durableDeliveryDigest>[0]) {
  const digest = durableDeliveryDigest(params);
  if (!digest) {
    return {};
  }
  return {
    message: `openclaw-media:${digest}`,
    upload: `openclaw-upload:${digest}`,
  };
}

function textDeliveryNonce(
  params: Parameters<typeof durableDeliveryDigest>[0],
): string | undefined {
  const digest = durableDeliveryDigest(params);
  return digest ? `openclaw-text:${digest}` : undefined;
}

async function attachUploadRetrySafe(params: {
  client: ClickClackClient;
  messageId: string;
  uploadId: string;
  assertDirectAdapterHandoff?: () => void;
}): Promise<void> {
  try {
    await params.client.attachUpload(params.messageId, params.uploadId);
  } catch (firstError) {
    // The attachment write is idempotent. A read distinguishes a lost success
    // response; otherwise one bounded retry reuses the same upload and message.
    // Keep currentness checks outside recovery catches so they cannot become retries.
    params.assertDirectAdapterHandoff?.();
    try {
      const persisted = await params.client.message(params.messageId);
      if (persisted.attachments?.some((attachment) => attachment.id === params.uploadId)) {
        return;
      }
    } catch {
      // A failed reconciliation read must not prevent the safe attach retry.
    }
    params.assertDirectAdapterHandoff?.();
    try {
      await params.client.attachUpload(params.messageId, params.uploadId);
    } catch {
      throw firstError;
    }
  }
}

function createOutboundContext(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  correlationId?: string;
  assertDirectAdapterHandoff?: () => void;
}) {
  const account = resolveClickClackAccount({ cfg: params.cfg, accountId: params.accountId });
  const assertDirectAdapterHandoff = params.assertDirectAdapterHandoff;
  const client = createClickClackClient({
    baseUrl: account.apiEndpoint,
    token: account.token,
    correlationId: params.correlationId,
    beforeRequest: assertDirectAdapterHandoff,
  });
  return { account, client };
}

/**
 * Sends visible text to a normalized ClickClack target and returns the created
 * message id, or undefined when sanitization removes all content.
 */
export async function sendClickClackText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  /** Safe request correlation inherited from an inbound ClickClack event. */
  correlationId?: string;
  /** Optional model/thinking attribution stamped onto the created message. */
  provenance?: ClickClackMessageProvenance;
  /** Opaque durable intent id used only to derive ClickClack's message nonce. */
  deliveryQueueId?: string;
  /** Stable platform-send index within the durable intent. */
  deliveryPartIndex?: number;
  /** Records recipient-visible dispatch immediately before message creation. */
  onPlatformSendDispatch?: () => Promise<void>;
  assertDirectAdapterHandoff?: () => void;
}): Promise<string | undefined> {
  // Custom inbound replies bypass shared outbound normalization, so this private
  // sender owns ClickClack assistant-text sanitization for every delivery path.
  const text = sanitizeAssistantVisibleText(params.text);
  if (!text) {
    return undefined;
  }
  const { account, client } = createOutboundContext(params);
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const message = await createTargetMessage({
    client,
    workspaceId,
    to: params.to,
    text,
    threadId: params.threadId,
    replyToId: params.replyToId,
    provenance: params.provenance,
    nonce: textDeliveryNonce(params),
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
  });
  return message.id;
}

export async function sendClickClackMedia(
  params: Omit<Parameters<typeof sendClickClackText>[0], "correlationId" | "provenance"> &
    Pick<OutboundMediaLoadOptions, "mediaAccess" | "mediaReadFile"> & {
      mediaUrl: string;
      mediaLocalRoots?: readonly string[];
      onDeliveryResult?: (result: {
        messageId: string;
        receipt: MessageReceipt;
      }) => Promise<void> | void;
    },
): Promise<string> {
  const nonces = mediaDeliveryNonces(params);
  const { account, client } = createOutboundContext(params);
  const maxBytes = Math.min(
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: account.accountId,
      resolveChannelLimitMb: () => account.config.mediaMaxMb,
    }) ?? CLICKCLACK_MAX_UPLOAD_BYTES,
    CLICKCLACK_MAX_UPLOAD_BYTES,
  );
  const mediaLoadOptions = {
    maxBytes,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  };
  const preloadedMedia = nonces.upload
    ? undefined
    : await loadOutboundMediaFromUrl(params.mediaUrl, mediaLoadOptions);
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const persistedUpload = nonces.upload
    ? await client.findUploadByNonce({ workspaceId, nonce: nonces.upload })
    : undefined;
  let upload = persistedUpload;
  let mediaFilename = preloadedMedia?.fileName?.trim();
  if (!upload) {
    const media =
      preloadedMedia ?? (await loadOutboundMediaFromUrl(params.mediaUrl, mediaLoadOptions));
    const contentType = media.contentType?.trim() || "application/octet-stream";
    const filename = media.fileName?.trim() || `attachment${extensionForMime(contentType) ?? ""}`;
    mediaFilename = filename;
    upload = await client.createUpload({
      workspaceId,
      buffer: media.buffer,
      filename,
      contentType,
      ...(nonces.upload ? { nonce: nonces.upload } : {}),
    });
  }
  const text =
    sanitizeAssistantVisibleText(params.text) || mediaFilename || upload.filename || "attachment";
  // Upload-first ordering lets crash recovery identify the durable object before
  // it creates or repairs the corresponding message.
  const message = await createTargetMessage({
    client,
    workspaceId,
    to: params.to,
    text,
    threadId: params.threadId,
    replyToId: params.replyToId,
    nonce: nonces.message,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
  });
  const receipt = createMessageReceiptFromOutboundResults({
    results: [{ channel: "clickclack", messageId: message.id }],
    threadId: params.threadId == null ? undefined : String(params.threadId),
    replyToId: params.replyToId == null ? undefined : String(params.replyToId),
    kind: "text",
  });
  try {
    // Preserve the accepted text identity if attachment fails. The final media
    // receipt replaces this progress result only after the upload is attached.
    await params.onDeliveryResult?.({ messageId: message.id, receipt });
    await attachUploadRetrySafe({
      client,
      messageId: message.id,
      uploadId: upload.id,
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    });
  } catch (error) {
    throw createChannelPartialDeliveryError(error, {
      visibleReplySent: true,
      messageIds: [message.id],
      receipt,
    });
  }
  return message.id;
}

/**
 * Completes an unknown durable send through ClickClack's message/upload nonces.
 * Media recovery never rereads the original source after restart.
 */
export async function reconcileClickClackUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  if (ctx.payloads.length !== 1 || (ctx.renderedBatchPlan?.items.length ?? 1) !== 1) {
    return {
      status: "unresolved",
      error: "ClickClack reconciliation requires exactly one payload",
    };
  }
  const payload = ctx.payloads[0];
  const plannedMediaUrls = ctx.renderedBatchPlan?.items[0]?.mediaUrls;
  const mediaUrls = normalizeTrimmedStringList(
    plannedMediaUrls?.length
      ? plannedMediaUrls
      : [payload?.mediaUrl, ...(payload?.mediaUrls ?? [])],
  );
  const { account, client } = createOutboundContext({
    cfg: ctx.cfg as CoreConfig,
    accountId: ctx.accountId,
  });
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const effectiveReplyToId =
    ctx.effectiveReplyToId !== undefined
      ? ctx.effectiveReplyToId
      : ctx.replyToMode === "off"
        ? undefined
        : ctx.replyToId;
  const caption = ctx.renderedBatchPlan?.items[0]?.text ?? payload?.text ?? "";
  if (mediaUrls.length === 0) {
    const nonce = textDeliveryNonce({
      deliveryQueueId: ctx.queueId,
      deliveryPartIndex: 0,
    });
    if (!nonce || !sanitizeAssistantVisibleText(caption)) {
      return { status: "not_sent" };
    }
    const message = await client.findMessageByNonce({ workspaceId, nonce });
    if (!message) {
      return { status: "not_sent" };
    }
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "clickclack", messageId: message.id }],
      threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
      replyToId: effectiveReplyToId ?? undefined,
      kind: "text",
    });
    return { status: "sent", messageId: message.id, receipt };
  }

  const parts = await Promise.all(
    mediaUrls.map(async (_mediaUrl, index) => {
      const nonces = mediaDeliveryNonces({
        deliveryQueueId: ctx.queueId,
        deliveryPartIndex: index,
      });
      if (!nonces.upload || !nonces.message) {
        throw new Error("ClickClack durable media nonces were not derived");
      }
      const [upload, message] = await Promise.all([
        client.findUploadByNonce({ workspaceId, nonce: nonces.upload }),
        client.findMessageByNonce({ workspaceId, nonce: nonces.message }),
      ]);
      return {
        upload,
        message,
      };
    }),
  );
  for (const part of parts) {
    if (part.message && !part.upload) {
      return {
        status: "unresolved",
        error: `ClickClack message ${part.message.id} exists without its nonce-keyed upload`,
        retryable: false,
      };
    }
    if (!part.message) {
      return { status: "not_sent" };
    }
  }

  const messageIds: string[] = [];
  for (const part of parts) {
    const message = part.message;
    const upload = part.upload;
    if (!message || !upload) {
      throw new Error("ClickClack reconciliation state changed unexpectedly");
    }
    if (!message.attachments?.some((attachment) => attachment.id === upload.id)) {
      await attachUploadRetrySafe({ client, messageId: message.id, uploadId: upload.id });
    }
    messageIds.push(message.id);
  }

  const receipt = createMessageReceiptFromOutboundResults({
    results: messageIds.map((messageId) => ({ channel: "clickclack", messageId })),
    threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
    replyToId: effectiveReplyToId ?? undefined,
    kind: "media",
  });
  const messageId = messageIds.at(-1);
  return { status: "sent", ...(messageId ? { messageId } : {}), receipt };
}
