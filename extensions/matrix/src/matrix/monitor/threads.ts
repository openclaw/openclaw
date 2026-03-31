import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { RelationType } from "./types.js";

type MatrixThreadReplies = "off" | "inbound" | "always";

function resolveMatrixRelatedReplyToEventId(relates: unknown): string | undefined {
  if (!relates || typeof relates !== "object") {
    return undefined;
  }
  if (
    "m.in_reply_to" in relates &&
    typeof relates["m.in_reply_to"] === "object" &&
    relates["m.in_reply_to"] &&
    "event_id" in relates["m.in_reply_to"] &&
    typeof relates["m.in_reply_to"].event_id === "string"
  ) {
    return relates["m.in_reply_to"].event_id;
  }
  return undefined;
}

export function resolveMatrixEffectiveThreadReplies(params: {
  isDirectMessage: boolean;
  threadReplies: MatrixThreadReplies;
  dmThreadReplies?: MatrixThreadReplies;
}): MatrixThreadReplies {
  return params.isDirectMessage && params.dmThreadReplies !== undefined
    ? params.dmThreadReplies
    : params.threadReplies;
}

export function resolveMatrixThreadSessionId(params: {
  effectiveThreadReplies: MatrixThreadReplies;
  messageId: string;
  threadRootId?: string;
  isThreadRoot?: boolean;
}): string | undefined {
  if (params.effectiveThreadReplies === "off") {
    return undefined;
  }
  const isThreadRoot = params.isThreadRoot === true;
  return params.threadRootId && params.threadRootId !== params.messageId && !isThreadRoot
    ? params.threadRootId
    : undefined;
}

export function resolveMatrixThreadTarget(params: {
  threadReplies: MatrixThreadReplies;
  messageId: string;
  threadRootId?: string;
  isThreadRoot?: boolean;
}): string | undefined {
  const { threadReplies, messageId, threadRootId } = params;
  if (threadReplies === "off") {
    return undefined;
  }
  const isThreadRoot = params.isThreadRoot === true;
  const hasInboundThread = Boolean(threadRootId && threadRootId !== messageId && !isThreadRoot);
  if (threadReplies === "inbound") {
    return hasInboundThread ? threadRootId : undefined;
  }
  if (threadReplies === "always") {
    return threadRootId ?? messageId;
  }
  return undefined;
}

export function resolveMatrixThreadRootId(params: {
  event: MatrixRawEvent;
  content: RoomMessageEventContent;
}): string | undefined {
  const relates = params.content["m.relates_to"];
  if (!relates || typeof relates !== "object") {
    return undefined;
  }
  if ("rel_type" in relates && relates.rel_type === RelationType.Thread) {
    if ("event_id" in relates && typeof relates.event_id === "string") {
      return relates.event_id;
    }
    return resolveMatrixRelatedReplyToEventId(relates);
  }
  return undefined;
}

export function resolveMatrixReplyToEventId(content: RoomMessageEventContent): string | undefined {
  return resolveMatrixRelatedReplyToEventId(content["m.relates_to"]);
}
