import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { ReplyPayload } from "../runtime-api.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type Maybe<T> = T | undefined;

const INFORMATIVE_STATUS_TEXTS = [
  "Thinking...",
  "Working on that...",
  "Checking the details...",
  "Putting an answer together...",
];

export function pickInformativeStatusText(random = Math.random): string {
  const index = Math.floor(random() * INFORMATIVE_STATUS_TEXTS.length);
  return INFORMATIVE_STATUS_TEXTS[index] ?? INFORMATIVE_STATUS_TEXTS[0];
}

// The SDK throws StreamCancelledError synchronously from stream.emit/update
// when the user pressed Stop in Teams (Teams replies 403 to the next chunk
// update and the SDK flips _canceled). Match by `name` rather than importing
// the class — tsgo can't resolve the re-export chain through
// @microsoft/teams.apps/dist/types/streamer, and the SDK's own code at
// utils/promises/retry.js falls back to this same name check.
function isStreamCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === "StreamCancelledError";
}

/**
 * Bridges openclaw's reply pipeline callbacks to the SDK's ctx.stream.
 * Streaming is enabled for personal (DM) conversations only; group/channel
 * messages fall through to block delivery.
 */
export function createTeamsReplyStreamController(params: {
  conversationType?: string;
  context: MSTeamsTurnContext;
  feedbackLoopEnabled: boolean;
  random?: () => number;
}) {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const stream = isPersonal ? params.context.stream : undefined;
  let tokensEmitted = false;
  let started = false;
  // Latches once we observe a cancellation so subsequent calls short-circuit
  // even if the SDK's `stream.canceled` getter is somehow stale.
  let canceledLocally = false;

  const wasCanceled = () => canceledLocally || Boolean(stream?.canceled);

  return {
    async onReplyStart(): Promise<void> {
      if (!stream || started || wasCanceled()) {
        return;
      }
      started = true;
      try {
        stream.update(pickInformativeStatusText(params.random));
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        throw err;
      }
    },

    onPartialReply(payload: { text?: string }): void {
      if (!stream || !payload.text || wasCanceled()) {
        return;
      }
      try {
        stream.emit(payload.text);
        tokensEmitted = true;
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        throw err;
      }
    },

    preparePayload(payload: ReplyPayload): Maybe<ReplyPayload> {
      if (!stream || !tokensEmitted) {
        return payload;
      }
      // User pressed Stop (or Teams ended the stream) — the streamed prefix
      // is already visible to the user. Dropping the payload here prevents a
      // second block message from re-delivering the rest, which would override
      // the explicit cancel intent.
      if (wasCanceled()) {
        return undefined;
      }
      const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
      return hasMedia ? { ...payload, text: undefined } : undefined;
    },

    async finalize(): Promise<void> {
      if (!stream || !tokensEmitted || wasCanceled()) {
        return;
      }
      // Emit a final MessageActivity carrying the AI-generated marker and (if
      // enabled) the feedback channelData. The SDK's HttpStream merges this
      // into the closing activity it sends to Teams.
      const finalEntities: Array<Record<string, unknown>> = [
        {
          type: "https://schema.org/Message",
          "@type": "Message",
          "@context": "https://schema.org",
          "@id": "",
          additionalType: ["AIGeneratedContent"],
        },
      ];
      const finalChannelData: Record<string, unknown> = params.feedbackLoopEnabled
        ? { feedbackLoopEnabled: true }
        : {};
      try {
        stream.emit({
          type: "message",
          entities: finalEntities,
          channelData: finalChannelData,
        });
        await stream.close();
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        throw err;
      }
    },

    hasStream(): boolean {
      return Boolean(stream);
    },

    isStreamActive(): boolean {
      return Boolean(stream) && tokensEmitted && !wasCanceled();
    },

    wasCanceled,
  };
}
