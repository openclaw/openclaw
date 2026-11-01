import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelPreflightAudio } from "openclaw/plugin-sdk/media-understanding-runtime";
import type { MattermostMediaInfo } from "./monitor-resources.js";
import type { ChatType } from "./runtime-api.js";

export function isMattermostAudioMedia(media: MattermostMediaInfo): boolean {
  const mime = media.contentType?.split(";")[0]?.trim().toLowerCase();
  return Boolean(media.path && mime?.startsWith("audio/"));
}

// The shared helper suppresses transcript echoes here: an admitted post is transcribed
// again by the normal media pass, which owns the echo, and a dropped post must not post.
const preflightAudio = createChannelPreflightAudio<MattermostMediaInfo>({
  channel: "mattermost",
  isAudio: isMattermostAudioMedia,
});

/**
 * Transcribes the first downloaded audio attachment so a spoken mention can admit a
 * media-only post in a mention-gated room. The transcript is used for admission only;
 * the shared media pipeline still transcribes the attachment for the agent. `chatType`
 * is the room kind the event plan resolved (private and group rooms are `group`) so
 * `tools.media.audio.scope` rules apply before any provider request.
 */
export async function resolveMattermostPreflightAudioTranscript(params: {
  media: readonly MattermostMediaInfo[];
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  sessionKey: string;
  chatType: ChatType;
  messageThreadId?: string;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  const audio = params.media.find(preflightAudio.isAudio);
  if (!audio?.path) {
    return undefined;
  }
  return await preflightAudio.resolve({
    request: {
      ctx: {
        media: [{ path: audio.path, contentType: audio.contentType ?? undefined }],
        Provider: "mattermost",
        Surface: "mattermost",
        OriginatingChannel: "mattermost",
        OriginatingTo: params.originatingTo,
        AccountId: params.accountId,
        MessageThreadId: params.messageThreadId,
        ChatType: params.chatType,
        SessionKey: params.sessionKey,
      },
      cfg: params.cfg,
    },
    abortSignal: params.abortSignal,
  });
}
