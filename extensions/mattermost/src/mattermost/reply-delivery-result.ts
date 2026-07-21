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

export type MattermostReplyDeliveryOutcome = "reasoning_skipped" | "empty" | "text" | "media";

export type MattermostReplyDeliverySource = {
  messageId?: string;
  receipt?: MessageReceipt;
  content?: string;
};

export type MattermostReplyDeliveryResult = {
  outcome: MattermostReplyDeliveryOutcome;
  visibleReplySent: boolean;
  messageIds?: string[];
  receipt?: MessageReceipt;
  content?: string;
};

export function isMattermostReplyDeliveryVisible(outcome: MattermostReplyDeliveryOutcome): boolean {
  return outcome === "text" || outcome === "media";
}

function hasProviderIdentity(
  result: MattermostReplyDeliverySource | null | undefined,
): result is MattermostReplyDeliverySource {
  return Boolean(
    result &&
    (result.messageId?.trim() ||
      result.receipt?.primaryPlatformMessageId?.trim() ||
      result.receipt?.platformMessageIds.length),
  );
}

function resolveVisibleContent(
  results: readonly MattermostReplyDeliverySource[],
): string | undefined {
  const contents = results.flatMap((result) =>
    result.content === undefined ? [] : [result.content],
  );
  if (contents.length === 0) {
    return undefined;
  }
  return contents.filter(Boolean).join("\n");
}

/** Normalizes every physical Mattermost post behind one logical reply payload. */
export function createMattermostReplyDeliveryResult(params: {
  outcome: MattermostReplyDeliveryOutcome;
  results?: readonly (MattermostReplyDeliverySource | null | undefined)[];
  content?: string;
  kind?: MessageReceiptPartKind;
}): MattermostReplyDeliveryResult {
  const visibleReplySent = isMattermostReplyDeliveryVisible(params.outcome);
  const allResults = params.results?.filter((result) => result != null) ?? [];
  const identifiedResults = visibleReplySent ? allResults.filter(hasProviderIdentity) : [];
  const receipt =
    identifiedResults.length > 0
      ? createMessageReceiptFromOutboundResults({
          results: identifiedResults,
          ...(params.kind ? { kind: params.kind } : {}),
        })
      : undefined;
  const content = params.content ?? resolveVisibleContent(allResults);
  return {
    outcome: params.outcome,
    visibleReplySent,
    ...(receipt?.platformMessageIds.length ? { messageIds: receipt.platformMessageIds } : {}),
    ...(receipt ? { receipt } : {}),
    ...(content === undefined ? {} : { content }),
  };
}

/** Merges preview finalization and supplemental sends without losing the preview identity. */
export function mergeMattermostReplyDeliveryResults(
  results: readonly MattermostReplyDeliveryResult[],
): MattermostReplyDeliveryResult {
  const visibleResults = results.filter((result) => result.visibleReplySent);
  const outcome: MattermostReplyDeliveryOutcome = visibleResults.some(
    (result) => result.outcome === "media",
  )
    ? "media"
    : visibleResults.length > 0
      ? "text"
      : results.every((result) => result.outcome === "reasoning_skipped")
        ? "reasoning_skipped"
        : "empty";
  return createMattermostReplyDeliveryResult({
    outcome,
    results: visibleResults,
  });
}

/** Keeps an already-visible subset attached to a later Mattermost delivery failure. */
export function createMattermostPartialReplyDeliveryError(
  cause: unknown,
  result: MattermostReplyDeliveryResult,
  pendingParts: readonly PendingReplyDeliveryPart[] = [],
): Error {
  if (!result.visibleReplySent) {
    return cause instanceof Error ? cause : new Error(formatErrorMessage(cause), { cause });
  }
  const messageId = result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined;
  return new PartialReplyDeliveryError(formatErrorMessage(cause), {
    cause,
    deliveryResult: {
      visibleReplySent: true,
      ...(messageId ? { messageId } : {}),
      ...(result.receipt ? { receipt: result.receipt } : {}),
      ...(result.content === undefined ? {} : { content: result.content }),
    },
    pendingParts,
  });
}
