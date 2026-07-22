import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export type FeishuReplyDeliverySource = {
  messageId?: string;
  receipt?: MessageReceipt;
};

export type FeishuReplyDeliveryResult = {
  messageIds?: string[];
  receipt?: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  content?: string;
};

export type FeishuReplyDeliveryResultWithFinalization = FeishuReplyDeliveryResult & {
  finalization: Promise<FeishuReplyDeliveryResult>;
};

const CHANNEL_PARTIAL_DELIVERY_ERROR_CODE = "OPENCLAW_CHANNEL_PARTIAL_DELIVERY";

export type FeishuPartialReplyDeliveryError = Error & {
  code: typeof CHANNEL_PARTIAL_DELIVERY_ERROR_CODE;
  deliveryResult: FeishuReplyDeliveryResult & { visibleReplySent: true };
};

export const noVisibleFeishuReplyDelivery: FeishuReplyDeliveryResult = {
  visibleReplySent: false,
};

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
  if (!receipt) {
    return {
      visibleReplySent: params.visibleReplySent,
      ...(params.content === undefined ? {} : { content: params.content }),
    };
  }
  return {
    messageIds: [...receipt.platformMessageIds],
    receipt,
    visibleReplySent: params.visibleReplySent,
    ...(params.content === undefined ? {} : { content: params.content }),
  };
}

/** Preserves the first result's provider identity while retaining supplemental ids. */
export function mergeFeishuReplyDeliveryResults(
  results: readonly FeishuReplyDeliveryResult[],
  content?: string,
): FeishuReplyDeliveryResult {
  const visible = results.filter((result) => result.visibleReplySent === true);
  return createFeishuReplyDeliveryResult({
    results: visible,
    visibleReplySent: visible.length > 0,
    content:
      content === undefined
        ? results.find((result) => result.content !== undefined)?.content
        : content,
  });
}

/** Keeps a failed outcome while exposing the provider-visible subset to core lifecycle hooks. */
export function createFeishuPartialReplyDeliveryError(
  cause: unknown,
  result: FeishuReplyDeliveryResult,
): Error {
  if (result.visibleReplySent !== true) {
    return cause instanceof Error ? cause : new Error(formatErrorMessage(cause), { cause });
  }
  return Object.assign(new Error(formatErrorMessage(cause), { cause }), {
    code: CHANNEL_PARTIAL_DELIVERY_ERROR_CODE,
    deliveryResult: { ...result, visibleReplySent: true as const },
  });
}

export function isFeishuPartialReplyDeliveryError(
  error: unknown,
): error is FeishuPartialReplyDeliveryError {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const candidate = error as { code?: unknown; deliveryResult?: unknown };
  return (
    candidate.code === CHANNEL_PARTIAL_DELIVERY_ERROR_CODE &&
    Boolean(
      candidate.deliveryResult &&
      typeof candidate.deliveryResult === "object" &&
      !Array.isArray(candidate.deliveryResult) &&
      (candidate.deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === true,
    )
  );
}

/** Attaches provider settlement without changing the immediate delivery result. */
export function withFeishuReplyFinalization(
  result: FeishuReplyDeliveryResult,
  finalization: Promise<FeishuReplyDeliveryResult>,
): FeishuReplyDeliveryResultWithFinalization {
  // Observe rejections here because core cannot await until the dispatcher finishes onIdle.
  void finalization.catch(() => undefined);
  return { ...result, finalization };
}
