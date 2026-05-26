import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { n as MsgContext, t as FinalizedMsgContext } from "./templating-BcdAlwzB.js";
import { n as ReplyDispatcher } from "./reply-dispatcher.types-CGAU-6ZQ.js";
import { r as GetReplyFromConfig, t as DispatchFromConfigResult } from "./dispatch-from-config.types-CYgSbSAE.js";
import { i as ReplyDispatcherWithTypingOptions, r as ReplyDispatcherOptions } from "./provider-dispatcher.types-CZaOPGb3.js";
//#region src/auto-reply/dispatch.d.ts
type DispatchInboundResult = DispatchFromConfigResult;
declare function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult>;
declare function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult>;
declare function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult>;
//#endregion
//#region src/auto-reply/heartbeat-reply-payload.d.ts
declare function resolveHeartbeatReplyPayload(replyResult: ReplyPayload | ReplyPayload[] | undefined): ReplyPayload | undefined;
//#endregion
export { dispatchInboundMessageWithDispatcher as i, dispatchInboundMessage as n, dispatchInboundMessageWithBufferedDispatcher as r, resolveHeartbeatReplyPayload as t };