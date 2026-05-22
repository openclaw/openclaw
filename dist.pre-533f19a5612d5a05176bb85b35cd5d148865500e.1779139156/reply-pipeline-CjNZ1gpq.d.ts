import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { c as SourceReplyDeliveryMode, u as ReplyPayload } from "./get-reply-options.types-Dr32ceD1.js";
import { n as InboundEventKind } from "./input-provenance-3g6zMdnU.js";
import { o as CommandTurnContext } from "./templating-CLzigwF3.js";
import { n as TypingCallbacks, t as CreateTypingCallbacksParams } from "./typing-C2GAgRFY.js";
import { i as createReplyPrefixOptions, n as ReplyPrefixOptions, t as ReplyPrefixContextBundle } from "./reply-prefix-C0MUVH9I.js";

//#region src/auto-reply/reply/source-reply-delivery-mode.d.ts
type SourceReplyDeliveryModeContext = {
  ChatType?: string;
  InboundEventKind?: InboundEventKind;
  CommandAuthorized?: boolean;
  CommandBody?: string;
  CommandSource?: "text" | "native";
  CommandTurn?: CommandTurnContext;
};
//#endregion
//#region src/channels/message/reply-pipeline.d.ts
type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
declare function resolveChannelSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  messageToolAvailable?: boolean;
}): SourceReplyDeliveryMode;
type ChannelReplyPipeline = ReplyPrefixOptions & {
  typingCallbacks?: TypingCallbacks;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};
type CreateChannelReplyPipelineParams = {
  cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
  agentId: string;
  channel?: string;
  accountId?: string;
  typing?: CreateTypingCallbacksParams;
  typingCallbacks?: TypingCallbacks;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};
declare function createChannelReplyPipeline(params: CreateChannelReplyPipelineParams): ChannelReplyPipeline;
//#endregion
export { resolveChannelSourceReplyDeliveryMode as a, createChannelReplyPipeline as i, CreateChannelReplyPipelineParams as n, ReplyPrefixContext as r, ChannelReplyPipeline as t };