/**
 * Merges media payloads discovered from attempt tool results.
 */
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../../../auto-reply/reply-payload.js";
import { hasReplyPayloadContent } from "../../../interactive/payload.js";
import { splitMediaFromOutput } from "../../../media/parse.js";
import {
  copyCoreTtsAttemptResultProvenance,
  getCoreTtsAttemptResultMediaUrls,
} from "../../tools/tts-tool-result-provenance.js";
import type { EmbeddedAgentRunResult } from "../types.js";

/** Channel payload shape produced by embedded runs after auto-reply normalization. */
type EmbeddedRunPayload = NonNullable<EmbeddedAgentRunResult["payloads"]>[number];

type ToolMediaBatch = {
  toolMediaUrls?: readonly string[];
  hostOwnedToolMediaUrls?: readonly string[];
  toolAutoDeliveryMediaUrls?: readonly string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
};

type ToolMediaMergeParams = ToolMediaBatch & {
  payloads?: EmbeddedRunPayload[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};

function selectToolMedia(params: ToolMediaMergeParams) {
  let mediaUrls = Array.from(
    new Set(params.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  const payloads = params.payloads?.length ? [...params.payloads] : [];
  const payloadIndex = payloads.findIndex((payload) => !payload.isReasoning && !payload.isError);
  const visiblePayload = payloads[payloadIndex];
  const isSourceReplyTranscriptMirror =
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    visiblePayload &&
    getReplyPayloadMetadata(visiblePayload)?.sourceReplyTranscriptMirror;
  if (visiblePayload?.text && mediaUrls.length > 0 && !isSourceReplyTranscriptMirror) {
    const selected = splitMediaFromOutput(visiblePayload.text, {
      extractAudioDirectives: false,
      extractMediaDirectives: false,
      markdownImageAllowlist: mediaUrls,
    });
    if (selected.mediaUrls?.length) {
      const selectedMediaUrls = new Set(selected.mediaUrls);
      mediaUrls = mediaUrls.filter((url) => selectedMediaUrls.has(url));
      payloads[payloadIndex] = copyReplyPayloadMetadata(visiblePayload, {
        ...visiblePayload,
        text: selected.text,
      });
    }
  }
  return { payloads, mediaUrls, payloadIndex, isSourceReplyTranscriptMirror };
}

/**
 * Merges media emitted by tools into the channel payloads produced by the
 * assistant turn. The first successful, non-reasoning reply owns the media so
 * text and attachments stay together; metadata is preserved for delivery bookkeeping.
 */
export function mergeAttemptToolMediaPayloads(
  params: ToolMediaMergeParams,
): EmbeddedRunPayload[] | undefined {
  return mergeSelectedToolMedia(params, selectToolMedia(params));
}

function mergeSelectedToolMedia(
  params: ToolMediaMergeParams,
  {
    payloads,
    mediaUrls,
    payloadIndex,
    isSourceReplyTranscriptMirror,
  }: ReturnType<typeof selectToolMedia>,
): EmbeddedRunPayload[] | undefined {
  const mediaUrlSet = new Set(mediaUrls);
  const autoDeliveryMediaUrls = Array.from(
    new Set(params.toolAutoDeliveryMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  const hostOwnedMediaUrls = Array.from(
    new Set(
      params.hostOwnedToolMediaUrls
        ?.map((url) => url.trim())
        .filter((url) => url.length > 0 && mediaUrlSet.has(url)) ?? [],
    ),
  );
  if (
    mediaUrls.length === 0 &&
    autoDeliveryMediaUrls.length === 0 &&
    !params.toolAudioAsVoice &&
    !params.toolTrustedLocalMedia
  ) {
    return params.payloads;
  }

  const buildMediaPayload = (urls: string[], includeAudio: boolean): EmbeddedRunPayload => ({
    mediaUrls: urls.length ? urls : undefined,
    mediaUrl: urls[0],
    audioAsVoice: (includeAudio && params.toolAudioAsVoice) || undefined,
    trustedLocalMedia: params.toolTrustedLocalMedia || undefined,
  });
  const shouldSplitHostOwnedMedia =
    params.sourceReplyDeliveryMode === "message_tool_only" && hostOwnedMediaUrls.length > 0;
  const hostOwnedMediaUrlSet = new Set(hostOwnedMediaUrls);
  const autoDeliveryOnlyMediaUrls = autoDeliveryMediaUrls.filter(
    (url) => !hostOwnedMediaUrlSet.has(url),
  );
  const shouldSplitAutoDeliveryMedia =
    params.sourceReplyDeliveryMode === "message_tool_only" && autoDeliveryOnlyMediaUrls.length > 0;
  const autoDeliveryMediaUrlSet = new Set(autoDeliveryMediaUrls);
  const mergeableMediaUrls =
    shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia
      ? mediaUrls.filter(
          (url) => !hostOwnedMediaUrlSet.has(url) && !autoDeliveryMediaUrlSet.has(url),
        )
      : mediaUrls;
  const appendOwnedMedia = (nextPayloads: EmbeddedRunPayload[]): EmbeddedRunPayload[] => {
    const withHostOwnedMedia = !shouldSplitHostOwnedMedia
      ? nextPayloads
      : [
          ...nextPayloads,
          markReplyPayloadForSourceSuppressionDelivery(
            buildMediaPayload(hostOwnedMediaUrls, false),
          ),
        ];
    if (!shouldSplitAutoDeliveryMedia) {
      return withHostOwnedMedia;
    }
    // Contract-owned media remains separate from private assistant text and
    // generic tool media so only its explicit provenance bypasses suppression.
    return [
      ...withHostOwnedMedia,
      markReplyPayloadForSourceSuppressionDelivery({
        ...buildMediaPayload(autoDeliveryOnlyMediaUrls, true),
        trustedLocalMedia: true,
      }),
    ];
  };

  // A transcript mirror is already delivered; every batch observes the same
  // exclusion, including media projected separately from the mirrored payload.
  if (isSourceReplyTranscriptMirror) {
    return appendOwnedMedia(payloads);
  }

  if (payloadIndex >= 0) {
    const payload = payloads.at(payloadIndex);
    if (!payload) {
      return payloads;
    }
    if (
      mergeableMediaUrls.length === 0 &&
      (shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia)
    ) {
      return appendOwnedMedia(payloads);
    }
    const mergedMediaUrls = Array.from(
      new Set([...(payload.mediaUrls ?? []), ...mergeableMediaUrls]),
    );
    payloads[payloadIndex] = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
      mediaUrl: payload.mediaUrl ?? mergedMediaUrls[0],
      audioAsVoice: payload.audioAsVoice || params.toolAudioAsVoice || undefined,
      trustedLocalMedia: payload.trustedLocalMedia || params.toolTrustedLocalMedia || undefined,
    });
    return appendOwnedMedia(payloads);
  }

  if (shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia) {
    const genericMediaPayload =
      mergeableMediaUrls.length > 0 ? [buildMediaPayload(mergeableMediaUrls, true)] : [];
    return appendOwnedMedia([...payloads, ...genericMediaPayload]);
  }

  const mediaPayload = buildMediaPayload(mergeableMediaUrls, true);

  // Reasoning-only turns still need a concrete media payload so channel delivery sees the attachment.
  return appendOwnedMedia([...payloads, mediaPayload]);
}

/** Keeps unsent artifacts with the logical run while their plugin generation retires. */
export function createPendingToolMediaCarry() {
  const batches: ToolMediaBatch[] = [];
  return {
    capture(attempt: ToolMediaBatch): void {
      if (!attempt.toolMediaUrls?.length && !attempt.toolAudioAsVoice) {
        return;
      }
      batches.push(
        copyCoreTtsAttemptResultProvenance(attempt, {
          toolMediaUrls: attempt.toolMediaUrls
            ? Object.freeze([...attempt.toolMediaUrls])
            : undefined,
          hostOwnedToolMediaUrls: attempt.hostOwnedToolMediaUrls
            ? Object.freeze([...attempt.hostOwnedToolMediaUrls])
            : undefined,
          toolAudioAsVoice: attempt.toolAudioAsVoice,
          toolTrustedLocalMedia: attempt.toolTrustedLocalMedia,
        }),
      );
    },
    merge(
      this: void,
      params: ToolMediaMergeParams,
      operationalRunInstance?: object,
    ): EmbeddedRunPayload[] | undefined {
      if (batches.length === 0) {
        return mergeAttemptToolMediaPayloads(params);
      }
      const pending = batches.map((batch) => ({
        ...batch,
        toolAutoDeliveryMediaUrls: getCoreTtsAttemptResultMediaUrls(
          batch,
          batch.toolMediaUrls,
          operationalRunInstance,
        ),
      }));
      const allBatches = [...pending, params];
      const selected = selectToolMedia({
        ...params,
        toolMediaUrls: allBatches.flatMap((batch) => batch.toolMediaUrls ?? []),
      });
      const selectedUrls = new Set(selected.mediaUrls);
      const projected = allBatches.map((batch) =>
        Object.assign({}, batch, {
          hadMedia: Boolean(batch.toolMediaUrls?.length || batch.toolAutoDeliveryMediaUrls?.length),
          toolMediaUrls: [
            ...new Set(
              batch.toolMediaUrls
                ?.map((url) => url.trim())
                .filter((url) => selectedUrls.has(url)) ?? [],
            ),
          ],
        }),
      );
      const owners = new Map<string, ToolMediaBatch>();
      // Keep the existing host-before-TTS-before-generic projection for an
      // artifact appearing in multiple batches, without combining their flags.
      for (const field of [
        "hostOwnedToolMediaUrls",
        "toolAutoDeliveryMediaUrls",
        "toolMediaUrls",
      ] as const) {
        for (const batch of projected) {
          for (const raw of batch[field] ?? []) {
            const url = raw.trim();
            if (
              (field !== "hostOwnedToolMediaUrls" || batch.toolMediaUrls.includes(url)) &&
              !owners.has(url)
            ) {
              owners.set(url, batch);
            }
          }
        }
      }
      const visible = selected.payloads[selected.payloadIndex];
      // Existing assistant media has its own provenance; carried media must
      // not promote it with another origin's trusted-local or voice flags.
      let payloads: EmbeddedRunPayload[] | undefined;
      if (visible?.mediaUrl || visible?.mediaUrls?.length) {
        payloads = selected.payloads;
      }
      if (visible && payloads && !selected.isSourceReplyTranscriptMirror) {
        const mediaUrl =
          visible.mediaUrl && !owners.has(visible.mediaUrl.trim()) ? visible.mediaUrl : undefined;
        const mediaUrls = visible.mediaUrls?.filter((url) => !owners.has(url.trim()));
        if (mediaUrl !== visible.mediaUrl || mediaUrls?.length !== visible.mediaUrls?.length) {
          // The source batch owns this exact artifact's flags. Leave unrelated
          // assistant media in place and carry its delivery metadata unchanged.
          payloads[selected.payloadIndex] = copyReplyPayloadMetadata(visible, {
            ...visible,
            mediaUrl,
            mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
            ...(!mediaUrl && !mediaUrls?.length
              ? { audioAsVoice: undefined, trustedLocalMedia: undefined }
              : {}),
          });
        }
      }
      for (const batch of projected) {
        const owned = (urls: readonly string[] | undefined) =>
          urls?.filter((url) => owners.get(url.trim()) === batch);
        const mediaUrls = owned(batch.toolMediaUrls) ?? [];
        const toolAutoDeliveryMediaUrls = owned(batch.toolAutoDeliveryMediaUrls);
        if (batch.hadMedia && mediaUrls.length === 0 && !toolAutoDeliveryMediaUrls?.length) {
          continue;
        }
        const first = payloads === undefined;
        // Selection is shared, but each origin keeps its own trust, voice and
        // suppression provenance. Combining flags would authorize unrelated media.
        const current = first
          ? selected
          : {
              payloads: [],
              payloadIndex: -1,
              isSourceReplyTranscriptMirror: selected.isSourceReplyTranscriptMirror,
            };
        const next = mergeSelectedToolMedia(
          {
            ...batch,
            toolAutoDeliveryMediaUrls,
            hostOwnedToolMediaUrls: owned(batch.hostOwnedToolMediaUrls),
            payloads: first ? selected.payloads : undefined,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          },
          {
            ...current,
            mediaUrls,
          },
        );
        payloads = payloads === undefined ? next : [...payloads, ...(next ?? [])];
      }
      const emptied = payloads?.[selected.payloadIndex];
      if (
        payloads &&
        visible &&
        emptied &&
        !hasReplyPayloadContent(emptied, {
          extraContent: emptied.audioAsVoice,
        })
      ) {
        const originalUrls = new Set(
          [...(visible.mediaUrls ?? []), ...(visible.mediaUrl ? [visible.mediaUrl] : [])].map(
            (url) => url.trim(),
          ),
        );
        const replacement = payloads.find(
          (payload, index) =>
            index >= selected.payloads.length &&
            [...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])].some(
              (url) => originalUrls.has(url),
            ),
        );
        if (replacement) {
          // The media-only original no longer reaches normalization or delivery.
          // Move its transcript/completion ownership to one surviving source batch.
          copyReplyPayloadMetadata(visible, replacement);
          payloads.splice(selected.payloadIndex, 1);
        }
      }
      return payloads ?? selected.payloads;
    },
    clear(): void {
      batches.length = 0;
    },
  };
}
