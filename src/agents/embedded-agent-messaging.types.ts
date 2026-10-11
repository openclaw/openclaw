/**
 * Shared messaging-tool metadata types captured from embedded-agent runs.
 */
import type { ReplyPayload } from "../shared/reply-payload.types.js";

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
  /** Authored by a `canDeliverSourceReply` tool: the host sends it, so the turn is complete. */
  toolAuthored?: true;
  /** Exact originating direct call; prevents suppression of another input's answer. */
  toolAuthoredForToolCallId?: string;
  /** Canonical assistant response/turn identity, or the native harness turn identity. */
  toolAuthoredForTurnId?: string;
};
