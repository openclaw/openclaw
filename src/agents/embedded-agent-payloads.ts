// Channel-facing reply payload emitted by embedded agents. Keep this type small:
// channel adapters decide how to render text/media/reply targeting.
import type { ReplyPayload } from "../auto-reply/reply-payload.js";

export type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  isReasoning?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
} & Pick<ReplyPayload, "presentation" | "interactive" | "channelData" | "delivery">;
