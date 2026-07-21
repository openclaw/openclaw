import {
  createMessageReceiptFromOutboundResults,
  resolveMessageReceiptPrimaryId,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  formatErrorMessage,
  PartialReplyDeliveryError,
  type PendingReplyDeliveryPart,
} from "openclaw/plugin-sdk/error-runtime";

export type FeishuReplyDeliverySource = {
  messageId?: string;
  receipt?: MessageReceipt;
};

export type FeishuReplyDeliveryResult = FeishuReplyDeliverySource & {
  visibleReplySent: boolean;
  content?: string;
};

export const noVisibleFeishuReplyDelivery: FeishuReplyDeliveryResult = {
  visibleReplySent: false,
};

export function toFeishuReplyDeliveryError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(formatErrorMessage(cause), { cause });
}

/** Internal progress retained while a later native send in the same reply fails. */
export class FeishuReplyDeliveryProgressError extends Error {
  readonly results: readonly FeishuReplyDeliverySource[];
  readonly visibleContent?: string;
  readonly pendingParts: readonly PendingReplyDeliveryPart[];

  constructor(
    cause: unknown,
    progress: {
      results?: readonly FeishuReplyDeliverySource[];
      visibleContent?: string;
      pendingParts?: readonly PendingReplyDeliveryPart[];
    },
  ) {
    super(formatErrorMessage(cause), { cause });
    this.name = "FeishuReplyDeliveryProgressError";
    this.results = [...(progress.results ?? [])];
    this.visibleContent = progress.visibleContent;
    this.pendingParts = [...(progress.pendingParts ?? [])];
  }
}

function hasProviderIdentity(
  result: FeishuReplyDeliverySource | null | undefined,
): result is FeishuReplyDeliverySource {
  return Boolean(
    result &&
    (result.messageId?.trim() ||
      result.receipt?.primaryPlatformMessageId?.trim() ||
      result.receipt?.platformMessageIds.length),
  );
}

/** Normalizes every physical Lark send behind one logical reply payload. */
export function createFeishuReplyDeliveryResult(params: {
  results?: readonly (FeishuReplyDeliverySource | null | undefined)[];
  visibleReplySent: boolean;
  content?: string;
  kind?: MessageReceiptPartKind;
}): FeishuReplyDeliveryResult {
  const results = params.visibleReplySent ? (params.results ?? []).filter(hasProviderIdentity) : [];
  const receipt =
    results.length > 0
      ? createMessageReceiptFromOutboundResults({
          results,
          ...(params.kind ? { kind: params.kind } : {}),
        })
      : undefined;
  const messageId = receipt ? resolveMessageReceiptPrimaryId(receipt) : undefined;
  return {
    visibleReplySent: params.visibleReplySent,
    ...(messageId ? { messageId } : {}),
    ...(receipt ? { receipt } : {}),
    ...(params.content === undefined ? {} : { content: params.content }),
  };
}

/** Preserves finalization-first identity while retaining supplemental media/chunk ids. */
export function mergeFeishuReplyDeliveryResults(
  results: readonly FeishuReplyDeliveryResult[],
): FeishuReplyDeliveryResult {
  const content = results.find((result) => result.content !== undefined)?.content;
  return createFeishuReplyDeliveryResult({
    results: results.filter((result) => result.visibleReplySent),
    visibleReplySent: results.some((result) => result.visibleReplySent),
    ...(content === undefined ? {} : { content }),
  });
}

/** Keeps a failed outcome while exposing the provider-visible subset to lifecycle observers. */
export function createFeishuPartialReplyDeliveryError(
  cause: unknown,
  result: FeishuReplyDeliveryResult,
  pendingParts: readonly PendingReplyDeliveryPart[] = [],
): Error {
  if (!result.visibleReplySent) {
    return toFeishuReplyDeliveryError(cause);
  }
  return new PartialReplyDeliveryError(formatErrorMessage(cause), {
    cause,
    deliveryResult: {
      ...result,
      visibleReplySent: true,
    },
    pendingParts,
  });
}
