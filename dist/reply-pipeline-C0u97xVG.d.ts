import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { a as SourceReplyDeliveryMode, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { n as InboundEventKind } from "./input-provenance-DgsxhTbk.js";
import { i as CommandTurnContext } from "./templating-DbSpLCuR.js";
import { n as TypingCallbacks, t as CreateTypingCallbacksParams } from "./typing-Bihu7fKL.js";
import { i as createReplyPrefixOptions, n as ReplyPrefixOptions, t as ReplyPrefixContextBundle } from "./reply-prefix-Bt-CJke9.js";

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