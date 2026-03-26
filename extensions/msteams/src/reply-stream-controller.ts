import type { ReplyPayload } from "../runtime-api.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { TeamsHttpStream } from "./streaming-message.js";

const INFORMATIVE_STATUS_TEXTS = [
  "Thinking...",
  "Working on that...",
  "Checking the details...",
  "Putting an answer together...",
];

export function pickInformativeStatusText(random = Math.random): string {
  const index = Math.floor(random() * INFORMATIVE_STATUS_TEXTS.length);
  return INFORMATIVE_STATUS_TEXTS[index] ?? INFORMATIVE_STATUS_TEXTS[0]!;
}

export function createTeamsReplyStreamController(params: {
  conversationType?: string;
  context: MSTeamsTurnContext;
  feedbackLoopEnabled: boolean;
  log: MSTeamsMonitorLogger;
  random?: () => number;
}) {
  const isPersonal = params.conversationType?.toLowerCase() === "personal";
  const stream = isPersonal
    ? new TeamsHttpStream({
        sendActivity: (activity) => params.context.sendActivity(activity),
        feedbackLoopEnabled: params.feedbackLoopEnabled,
        onError: (err) => {
          params.log.debug?.(`stream error: ${err instanceof Error ? err.message : String(err)}`);
        },
      })
    : undefined;

  let streamReceivedTokens = false;
  let informativeUpdateSent = false;

  return {
    async onReplyStart(): Promise<void> {
      if (!stream || informativeUpdateSent) {
        return;
      }
      informativeUpdateSent = true;
      await stream.sendInformativeUpdate(pickInformativeStatusText(params.random));
    },

    onPartialReply(payload: { text?: string }): void {
      if (!stream || !payload.text) {
        return;
      }
      streamReceivedTokens = true;
      stream.update(payload.text);
    },

    preparePayload(payload: ReplyPayload): ReplyPayload | undefined {
      if (!stream || !streamReceivedTokens || !stream.hasContent) {
        return payload;
      }

      const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
      if (!hasMedia) {
        return undefined;
      }
      return { ...payload, text: undefined };
    },

    async finalize(): Promise<void> {
      await stream?.finalize();
    },

    hasStream(): boolean {
      return Boolean(stream);
    },
  };
}
