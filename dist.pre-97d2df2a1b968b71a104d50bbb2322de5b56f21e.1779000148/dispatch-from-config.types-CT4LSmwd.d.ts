import { i as OpenClawConfig } from "./types.openclaw-BuKAF4PW.js";
import { c as SourceReplyDeliveryMode, r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-DJsrtcW0.js";
import { n as MsgContext, t as FinalizedMsgContext } from "./templating-BKUxbw7m.js";
import { n as ReplyDispatcher, t as ReplyDispatchKind } from "./reply-dispatcher.types-Dt1mIEnt.js";

//#region src/auto-reply/reply/abort.runtime-types.d.ts
type FastAbortResult = {
  handled: boolean;
  aborted: boolean;
  stoppedSubagents?: number;
};
type TryFastAbortFromMessage = (params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}) => Promise<FastAbortResult>;
type FormatAbortReplyText = (stoppedSubagents?: number) => string;
//#endregion
//#region src/auto-reply/reply/get-reply.types.d.ts
type GetReplyFromConfig = (ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
//#region src/auto-reply/reply/dispatch-from-config.types.d.ts
type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
  failedCounts?: Partial<Record<ReplyDispatchKind, number>>;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  beforeAgentRunBlocked?: boolean;
};
type DispatchFromConfigParams = {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
  fastAbortResolver?: TryFastAbortFromMessage;
  formatAbortReplyTextResolver?: FormatAbortReplyText; /** Optional patch applied to the already loaded config before reply resolution. */
  configOverride?: OpenClawConfig;
};
type DispatchReplyFromConfig = (params: DispatchFromConfigParams) => Promise<DispatchFromConfigResult>;
//#endregion
export { DispatchReplyFromConfig as n, GetReplyFromConfig as r, DispatchFromConfigResult as t };