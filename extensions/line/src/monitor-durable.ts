import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

type LineDurableReplyOptions = {
  to: string;
};

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
  const lineData = params.payload.channelData?.line;
  if (lineData && Object.keys(lineData).length > 0) {
    return false;
  }
  const reply = resolveSendableOutboundReplyParts(params.payload);
  if (reply.hasMedia || !reply.hasText) {
    return false;
  }
  return {
    to: params.to,
  };
}
