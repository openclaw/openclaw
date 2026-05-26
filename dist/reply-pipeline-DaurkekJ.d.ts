import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { a as SourceReplyDeliveryMode, s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { n as TypingCallbacks, t as CreateTypingCallbacksParams } from "./typing-BbmkR-wF.js";
import { i as createReplyPrefixOptions, n as ReplyPrefixOptions, t as ReplyPrefixContextBundle } from "./reply-prefix-aWQydCzb.js";

//#region src/auto-reply/reply/source-reply-delivery-mode.d.ts
type SourceReplyDeliveryModeContext = {
  ChatType?: string;
  CommandAuthorized?: boolean;
  CommandBody?: string;
  CommandSource?: "text" | "native";
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