// Mattermost plugin module owns draft-preview final delivery.
import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createPreviewMessageReceipt,
  type LivePreviewDeliveryResult,
  type LivePreviewLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReasoningReplyPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { updateMattermostPost, type MattermostClient } from "./client.js";
import { canFinalizeMattermostPreviewInPlace } from "./monitor-context.js";
import {
  joinMattermostVisibleContent,
  type MattermostReplyDeliveryResult,
} from "./reply-delivery.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";

export type MattermostPreviewFinalResolution = {
  editText?: string;
  deliveryText?: string;
  confirmedDelivery?: MattermostReplyDeliveryResult;
  alreadyDelivered: boolean;
};

type MattermostDraftPreviewDeliverParams = {
  payload: ReplyPayload;
  info: { kind: "tool" | "block" | "final" };
  kind: ChatType;
  client: MattermostClient;
  previewLifecycle: LivePreviewLifecycle<ReplyPayload, string>;
  effectiveReplyToId?: string;
  separateProgressFinalDelivery?: boolean;
  resolvePreviewFinalText: (text?: string) => MattermostPreviewFinalResolution | undefined;
  logVerboseMessage: (message: string) => void;
  deliverPayload: (payload: ReplyPayload) => Promise<MattermostReplyDeliveryResult>;
  // Visible same-thread finals can be delivered by editing the draft preview in
  // place (onPreviewFinalized) without ever calling deliverPayload; this lets the
  // caller record thread participation on that path too.
  recordThreadParticipation?: () => Promise<void> | void;
};

function combineMattermostVisibleDeliveryResults(
  results: readonly (LivePreviewDeliveryResult | undefined)[],
  outcome: "text" | "media",
): MattermostReplyDeliveryResult | undefined {
  const visibleResults = results.filter(
    (result): result is LivePreviewDeliveryResult => result?.visibleReplySent === true,
  );
  if (visibleResults.length === 0) {
    return undefined;
  }
  return {
    outcome,
    ...createAcceptedChannelDeliveryResult({
      deliveryResults: visibleResults,
      content: joinMattermostVisibleContent(visibleResults.map((result) => result.content)),
    }),
  };
}

export async function deliverMattermostReplyWithDraftPreview(
  params: MattermostDraftPreviewDeliverParams,
): Promise<MattermostReplyDeliveryResult> {
  if (isReasoningReplyPayload(params.payload)) {
    if (params.info.kind === "final") {
      params.previewLifecycle.observeSuppression();
    }
    return {
      outcome: "reasoning_skipped",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    };
  }

  let outcome: "text" | "media" = "text";
  const ttsSupplement = getReplyPayloadTtsSupplement(params.payload);
  const previewFinalResolution =
    params.info.kind === "final" &&
    !params.separateProgressFinalDelivery &&
    !params.previewLifecycle.previewFinalized
      ? params.resolvePreviewFinalText(params.payload.text ?? ttsSupplement?.spokenText)
      : undefined;
  const confirmedPreviewDelivery = previewFinalResolution?.confirmedDelivery;
  const previewFinalDeliveryText = previewFinalResolution?.deliveryText;
  let previewFinalTextAlreadyDelivered =
    previewFinalResolution?.alreadyDelivered === true && params.payload.isError !== true;
  if (
    previewFinalTextAlreadyDelivered &&
    !resolveSendableOutboundReplyParts(params.payload).hasMedia &&
    !params.payload.presentation &&
    confirmedPreviewDelivery?.visibleReplySent
  ) {
    try {
      await params.previewLifecycle.observeDelivery(confirmedPreviewDelivery);
      await params.recordThreadParticipation?.();
      return confirmedPreviewDelivery;
    } catch (error) {
      throw createChannelPartialDeliveryError(error, {
        ...confirmedPreviewDelivery,
        visibleReplySent: true,
      });
    }
  }
  try {
    const finalization = await params.previewLifecycle.deliver<{ message: string }>({
      kind: params.info.kind,
      payload: params.payload,
      isError: params.payload.isError,
      adapter: {
        buildFinalEdit: (payload) => {
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
          const previewFinalText = previewFinalResolution?.editText;

          if (
            (hasMedia && !ttsSupplement) ||
            typeof previewFinalText !== "string" ||
            payload.isError ||
            payload.presentation ||
            !canFinalizeMattermostPreviewInPlace({
              kind: params.kind,
              previewRootId: params.effectiveReplyToId,
              threadRootId: params.effectiveReplyToId,
              replyToId: payload.replyToId,
            })
          ) {
            return undefined;
          }
          return { message: previewFinalText };
        },
        editFinal: async (previewPostId, edit) => {
          const post = await updateMattermostPost(params.client, previewPostId, edit);
          const receipt = createPreviewMessageReceipt({ id: post.id ?? previewPostId });
          return {
            messageIds: receipt.platformMessageIds,
            receipt,
            visibleReplySent: true,
            content: post.message ?? edit.message,
          };
        },
        onPreviewFinalized: async () => {
          // Supplemental retries must not repost text already committed by the preview edit.
          previewFinalTextAlreadyDelivered = true;
          await params.recordThreadParticipation?.();
        },
        buildSupplementalPayload: (payload) =>
          getReplyPayloadTtsSupplement(payload)
            ? buildTtsSupplementMediaPayload(payload)
            : undefined,
        deliverSupplemental: async (payload) => {
          const delivered = await params.deliverPayload(payload);
          if (delivered.outcome === "media") {
            outcome = "media";
          }
          return delivered.visibleReplySent ? delivered : false;
        },
        logPreviewEditFailure: (err) => {
          params.logVerboseMessage(
            `mattermost preview final edit failed; falling back to normal send (${String(err)})`,
          );
        },
      },
      deliverNormally: async (payload) => {
        const supplement = getReplyPayloadTtsSupplement(payload);
        const resolvedDeliveryText =
          previewFinalDeliveryText ?? (previewFinalTextAlreadyDelivered ? "" : undefined);
        const payloadText = payload.text?.trim();
        // TTS metadata is authoritative when its text is already visible. Only restore
        // spoken text when neither that contract nor provider-confirmed preview posts cover it.
        const deliveryPayload =
          payload.isError !== true &&
          supplement &&
          (previewFinalTextAlreadyDelivered ||
            (!payloadText && supplement.visibleTextAlreadyDelivered === true))
            ? buildTtsSupplementMediaPayload(payload)
            : payload.isError !== true && supplement && !payloadText
              ? {
                  ...payload,
                  text: resolvedDeliveryText?.trim() ? resolvedDeliveryText : supplement.spokenText,
                }
              : payload.isError !== true && typeof resolvedDeliveryText === "string"
                ? { ...payload, text: resolvedDeliveryText }
                : payload;
        const delivered = await params.deliverPayload(deliveryPayload);
        if (delivered.outcome === "media") {
          outcome = "media";
        }
        return delivered;
      },
      onNormalDelivered: params.recordThreadParticipation,
    });

    return (
      combineMattermostVisibleDeliveryResults(
        [confirmedPreviewDelivery, finalization.deliveryResult],
        outcome,
      ) ?? {
        outcome: "empty",
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" },
      }
    );
  } catch (error: unknown) {
    // Core owns receipts from this delivery. Only prepend earlier sealed
    // assistant generations that were not part of its send/edit operation.
    if (!confirmedPreviewDelivery?.visibleReplySent) {
      throw error;
    }
    const failedPartial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    throw createChannelPartialDeliveryError(
      error,
      createAcceptedChannelDeliveryResult({
        deliveryResults: [confirmedPreviewDelivery, ...(failedPartial ? [failedPartial] : [])],
        content: joinMattermostVisibleContent([
          confirmedPreviewDelivery.content,
          failedPartial?.content,
        ]),
      }),
    );
  }
}
