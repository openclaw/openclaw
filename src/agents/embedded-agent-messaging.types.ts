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
  /**
   * Comparison digest of a `text` a bounded retention holder had to drop.
   * Reply dedupe (`reply-payloads-dedupe.ts`) recognizes an already-delivered
   * reply by comparing this send's exported `text`; a producer that drops the
   * body to stay inside its retention budget keeps route-scoped exact-repeat
   * suppression working by exporting this digest in its place. Digest of
   * `normalizeTextForComparison(text)`.
   */
  textComparisonDigest?: string;
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
