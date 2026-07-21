// Mattermost plugin module owns draft-preview final delivery.
import {
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { PartialReplyDeliveryError } from "openclaw/plugin-sdk/error-runtime";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { updateMattermostPost, type MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { canFinalizeMattermostPreviewInPlace } from "./monitor-context.js";
import {
  createMattermostPartialReplyDeliveryError,
  createMattermostReplyDeliveryResult,
  mergeMattermostReplyDeliveryResults,
  type MattermostReplyDeliveryResult,
} from "./reply-delivery-result.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";

export type MattermostDraftPreviewState = {
  finalizedViaPreviewPost: boolean;
};

type MattermostDraftPreviewDeliverParams = {
  payload: ReplyPayload;
  info: { kind: "tool" | "block" | "final" };
  kind: ChatType;
  client: MattermostClient;
  draftStream: Pick<
    ReturnType<typeof createMattermostDraftStream>,
    "flush" | "postId" | "clear" | "discardPending" | "seal"
  >;
  effectiveReplyToId?: string;
  resolvePreviewFinalText: (text?: string) => string | undefined;
  previewState: MattermostDraftPreviewState;
  logVerboseMessage: (message: string) => void;
  deliverPayload: (payload: ReplyPayload) => Promise<MattermostReplyDeliveryResult>;
  // Visible same-thread finals can be delivered by editing the draft preview in
  // place (onPreviewFinalized) without ever calling deliverPayload; this lets the
  // caller record thread participation on that path too.
  recordThreadParticipation?: () => void;
};

export async function deliverMattermostReplyWithDraftPreview(
  params: MattermostDraftPreviewDeliverParams,
): Promise<MattermostReplyDeliveryResult> {
  if (isReasoningReplyPayload(params.payload)) {
    return createMattermostReplyDeliveryResult({ outcome: "reasoning_skipped" });
  }

  let normalResult: MattermostReplyDeliveryResult | undefined;
  // Preserve the finalized preview before supplemental delivery starts so a
  // later media failure still reports the visible preview id and content.
  let previewResult: MattermostReplyDeliveryResult | undefined;
  const supplementalResults: MattermostReplyDeliveryResult[] = [];
  let finalizedPreviewId: string | undefined;
  let finalizedPreviewContent: string | undefined;
  try {
    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: params.info.kind,
      payload: params.payload,
      adapter: defineFinalizableLivePreviewAdapter<ReplyPayload, string, { message: string }>({
        draft: {
          flush: params.draftStream.flush,
          clear: params.draftStream.clear,
          discardPending: params.draftStream.discardPending,
          seal: params.draftStream.seal,
          id: params.draftStream.postId,
        },
        buildFinalEdit: (payload) => {
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
          const ttsSupplement = getReplyPayloadTtsSupplement(payload);
          const previewFinalText = params.resolvePreviewFinalText(
            payload.text ?? ttsSupplement?.spokenText,
          );

          if (
            (hasMedia && !ttsSupplement) ||
            typeof previewFinalText !== "string" ||
            payload.isError ||
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
          const updated = await updateMattermostPost(params.client, previewPostId, edit);
          finalizedPreviewId = updated.id?.trim() || previewPostId;
          finalizedPreviewContent = updated.message ?? edit.message;
        },
        resolveFinalizedId: (previewPostId) => finalizedPreviewId ?? previewPostId,
        onPreviewFinalized: (messageId, receipt) => {
          previewResult = createMattermostReplyDeliveryResult({
            outcome: "text",
            results: [
              {
                messageId,
                receipt,
                content: finalizedPreviewContent,
              },
            ],
          });
          params.previewState.finalizedViaPreviewPost = true;
          // The visible final reply landed by editing the preview post, so the normal
          // deliverPayload record path is skipped; record participation explicitly here.
          params.recordThreadParticipation?.();
        },
        buildSupplementalPayload: (payload) =>
          getReplyPayloadTtsSupplement(payload)
            ? buildTtsSupplementMediaPayload(payload)
            : undefined,
        deliverSupplemental: async (payload) => {
          const supplementalResult = await params.deliverPayload(payload);
          supplementalResults.push(supplementalResult);
          return supplementalResult.visibleReplySent;
        },
        logPreviewEditFailure: (err) => {
          params.logVerboseMessage(
            `mattermost preview final edit failed; falling back to normal send (${String(err)})`,
          );
        },
      }),
      deliverNormally: async (payload) => {
        const supplement = getReplyPayloadTtsSupplement(payload);
        normalResult = await params.deliverPayload(
          supplement && !payload.text?.trim() && supplement.visibleTextAlreadyDelivered !== true
            ? { ...payload, text: supplement.spokenText }
            : payload,
        );
        return normalResult.visibleReplySent;
      },
    });
    if (result.kind === "preview-finalized" && previewResult) {
      return mergeMattermostReplyDeliveryResults([previewResult, ...supplementalResults]);
    }
    if (normalResult) {
      return normalResult;
    }
    return createMattermostReplyDeliveryResult({ outcome: "empty" });
  } catch (error) {
    if (!previewResult?.visibleReplySent) {
      throw error;
    }
    const nestedPartialResult =
      error instanceof PartialReplyDeliveryError
        ? createMattermostReplyDeliveryResult({
            outcome: "media",
            results: [error.deliveryResult],
          })
        : undefined;
    throw createMattermostPartialReplyDeliveryError(
      error,
      mergeMattermostReplyDeliveryResults([
        previewResult,
        ...supplementalResults,
        ...(nestedPartialResult ? [nestedPartialResult] : []),
      ]),
      error instanceof PartialReplyDeliveryError
        ? error.pendingParts
        : [{ kind: "media", index: supplementalResults.length }],
    );
  }
}
