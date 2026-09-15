// Line plugin module implements monitor durable behavior.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { LineChannelData } from "./types.js";

type LineDurableReplyOptions = {
  to: string;
};

function hasLineChannelData(payload: ReplyPayload): boolean {
  const lineData = payload.channelData?.line as LineChannelData | undefined;
  return Boolean(lineData && Object.keys(lineData).length > 0);
}

export function resolveLineDurableReplyOptions(params: {
  payload: ReplyPayload;
  infoKind: string;
  to: string;
  replyToken?: string | null;
  replyTokenUsed: boolean;
}): LineDurableReplyOptions | false {
  if (params.infoKind !== "final") {
    return false;
  }
  if (params.replyToken && !params.replyTokenUsed) {
    return false;
  }
  // Widening which replies take the durable path is a separate contract change
  // from resolving one that was interrupted, so rich and media replies keep the
  // inline path this fix does not touch.
  if (hasLineChannelData(params.payload)) {
    return false;
  }
  const reply = resolveSendableOutboundReplyParts(params.payload);
  if (reply.hasMedia || !reply.hasText) {
    return false;
  }
  // No reply-to here: core takes it from the payload or the turn context, and the
  // outbound adapter turns it into a quote on the request it records.
  return { to: params.to };
}
