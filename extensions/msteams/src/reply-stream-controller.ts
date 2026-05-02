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

  return {
    async onReplyStart(): Promise<void> {
      if (!stream || started) {
        return;
      }
      started = true;
      stream.update(pickInformativeStatusText(params.random));
    },

    onPartialReply(payload: { text?: string }): void {
      if (!stream || !payload.text) {
        return;
      }
      tokensEmitted = true;
      stream.emit(payload.text);
    },

    preparePayload(payload: ReplyPayload): Maybe<ReplyPayload> {
      if (!stream || !tokensEmitted || stream.canceled) {
        return payload;
      }
      const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
      return hasMedia ? { ...payload, text: undefined } : undefined;
    },

    async finalize(): Promise<void> {
      if (!stream || !tokensEmitted || stream.canceled) {
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
      stream.emit({
        type: "message",
        entities: finalEntities,
        channelData: finalChannelData,
      });
      await stream.close();
    },

    hasStream(): boolean {
      return Boolean(stream);
    },

    isStreamActive(): boolean {
      return Boolean(stream) && tokensEmitted && !stream!.canceled;
    },
  };
}
