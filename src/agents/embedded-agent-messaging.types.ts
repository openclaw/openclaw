/**
 * Shared messaging-tool metadata types captured from embedded-agent runs.
 */
import type { ReplyPayload } from "../auto-reply/reply-payload.js";

export type MessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  threadImplicit?: boolean;
  threadSuppressed?: boolean;
  text?: string;
  mediaUrls?: string[];
  hasRichContent?: true;
  /** Current-source progress (`false`) or completed reply (`true`). */
  sourceReplyFinal?: boolean;
};

export type MessagingToolSourceReplyPayload = Pick<
  ReplyPayload,
  | "audioAsVoice"
  | "attachments"
  | "channelData"
  | "interactive"
  | "mediaUrl"
  | "mediaUrls"
  | "presentation"
  | "text"
  | "trustedLocalMedia"
> & {
  idempotencyKey?: string;
  transcriptOwner?: true;
  /** Current-source progress (`false`) or completed reply (`true`). */
  sourceReplyFinal?: boolean;
  /**
   * Authored by a `canDeliverSourceReply` tool and not yet sent: the host delivers it
   * to the current source like assistant text instead of mirroring an already-sent reply.
   */
  toolAuthored?: true;
};
