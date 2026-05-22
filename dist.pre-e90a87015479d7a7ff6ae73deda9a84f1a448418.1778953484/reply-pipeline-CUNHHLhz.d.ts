import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { c as ReplyPayload, o as SourceReplyDeliveryMode } from "./get-reply-options.types-CEbMlRdT.js";
import { n as TypingCallbacks, t as CreateTypingCallbacksParams } from "./typing-DhV8q8je.js";
import { i as createReplyPrefixOptions, n as ReplyPrefixOptions, t as ReplyPrefixContextBundle } from "./reply-prefix-Cm6ctdNh.js";

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