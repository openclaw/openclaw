import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type { LivePreviewDeliveryResult } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { resolveMatrixExtraContent } from "../../outbound.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { sendMessageMatrix } from "../send.js";
import type { MatrixSendResult } from "../send/types.js";

export type MatrixReplyDeliveryResult = LivePreviewDeliveryResult;

function joinMatrixVisibleContent(contents: readonly (string | undefined)[]): string {
  return contents.filter((content): content is string => Boolean(content)).join("\n");
}

export function mergeMatrixReplyDeliveryResults(
  results: readonly MatrixReplyDeliveryResult[],
): MatrixReplyDeliveryResult {
  const single = results.length === 1 ? results[0] : undefined;
  if (single?.visibleReplySent) {
    return single;
  }
  const visibleResults = results.filter((result) => result.visibleReplySent);
  if (visibleResults.length === 0) {
    return {
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    };
  }
  const content = joinMatrixVisibleContent(visibleResults.map((result) => result.content));
  if (visibleResults.some((result) => result.receipt || result.messageIds?.length)) {
    return createAcceptedChannelDeliveryResult({ deliveryResults: visibleResults, content });
  }
  return {
    visibleReplySent: true,
    content,
  };
}

export function toMatrixPartialDeliveryError(
  error: unknown,
  settled: readonly MatrixReplyDeliveryResult[],
): unknown {
  const failedPartial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  const merged = mergeMatrixReplyDeliveryResults([
    ...settled,
    ...(failedPartial ? [failedPartial] : []),
  ]);
  return merged.visibleReplySent
    ? createChannelPartialDeliveryError(error, { ...merged, visibleReplySent: true })
    : error;
}

function createMatrixReplyDeliveryResult(
  results: readonly MatrixSendResult[],
): MatrixReplyDeliveryResult {
  if (results.length === 0) {
    return mergeMatrixReplyDeliveryResults([]);
  }
  return createAcceptedChannelDeliveryResult({
    results: results.map((result) => ({ receipt: result.receipt })),
    content: joinMatrixVisibleContent(results.map((result) => result.content)),
  });
}

function resolveVisibleMatrixReplyText(text?: string): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return text;
  }
  if (normalizeLowercaseStringOrEmpty(trimmedStart).startsWith("reasoning:")) {
    return undefined;
  }
  const visibleText = stripReasoningTagsFromText(text, { mode: "strict", trim: "none" });
  return visibleText.trim() ? visibleText : undefined;
}

export async function deliverMatrixReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  replyToMode: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  threadId?: string;
  replyToId?: string;
  accountId?: string;
  mediaLocalRoots?: readonly string[];
}): Promise<MatrixReplyDeliveryResult> {
  const core = getMatrixRuntime();
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      params.runtime.log?.(message);
    }
  };
  const hasRepliedRef = params.hasRepliedRef ?? { value: false };
  const acceptedResults: MatrixSendResult[] = [];
  try {
    for (const reply of params.replies) {
      const visibleText = resolveVisibleMatrixReplyText(reply.text);
      const { hasMedia, hasText, mediaUrls } = resolveSendableOutboundReplyParts(reply);
      if (reply.isReasoning === true || (!hasMedia && reply.text && visibleText === undefined)) {
        logVerbose("matrix reply suppressed as reasoning-only");
        continue;
      }
      if (!hasText && !hasMedia) {
        if (reply?.audioAsVoice) {
          logVerbose("matrix reply has audioAsVoice without media/text; skipping");
          continue;
        }
        params.runtime.error?.("matrix reply missing text/media");
        continue;
      }
      const explicitReplyToId =
        reply.replyToTag || reply.replyToCurrent ? reply.replyToId?.trim() : undefined;
      const rawText = visibleText ?? "";

      const replyToIdForReply =
        explicitReplyToId ||
        (!params.threadId &&
        params.replyToMode !== "off" &&
        (params.replyToMode === "all" || !hasRepliedRef.value)
          ? (reply.replyToId ?? params.replyToId)?.trim()
          : undefined);
      const fallbackReplyToId = params.threadId
        ? (reply.replyToId ?? params.replyToId)?.trim()
        : undefined;
      const onDeliveryResult = (result: MatrixSendResult) => {
        // A concrete event consumes the first-reply slot even when a later event fails.
        acceptedResults.push(result);
        if (replyToIdForReply) {
          hasRepliedRef.value = true;
        }
      };

      // The reply's own event fields ride its first event, exactly as the outbound
      // send path places them; a later chunk would attach them to the wrong event.
      const extraContent = resolveMatrixExtraContent(reply);

      // Text and media replies share the same accepted-event and reply-slot owner.
      const targets = mediaUrls.length > 0 ? mediaUrls : [undefined];
      for (const [index, mediaUrl] of targets.entries()) {
        await sendMessageMatrix(params.roomId, index === 0 ? rawText : "", {
          client: params.client,
          cfg: params.cfg,
          ...(mediaUrl !== undefined
            ? {
                mediaUrl,
                mediaLocalRoots: params.mediaLocalRoots,
                audioAsVoice: reply.audioAsVoice,
              }
            : {}),
          replyToId: replyToIdForReply,
          fallbackReplyToId,
          threadId: params.threadId,
          accountId: params.accountId,
          extraContent: index === 0 ? extraContent : undefined,
          onDeliveryResult,
        });
      }
    }
  } catch (error: unknown) {
    throw toMatrixPartialDeliveryError(error, [createMatrixReplyDeliveryResult(acceptedResults)]);
  }
  return createMatrixReplyDeliveryResult(acceptedResults);
}
