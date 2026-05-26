import { Pn as SilentReplyConversationType, i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { v as HumanDelayConfig } from "./types.base-DS--yneR.js";
import { n as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { n as MsgContext, t as FinalizedMsgContext } from "./templating-DbSpLCuR.js";
import { n as ReplyDispatcher, t as ReplyDispatchKind } from "./reply-dispatcher.types-ZeVAzUxF.js";
import { r as GetReplyFromConfig, t as DispatchFromConfigResult } from "./dispatch-from-config.types-D9GatrrF.js";
import { i as ResponsePrefixContext, n as TypingCallbacks } from "./typing-Bihu7fKL.js";

//#region src/auto-reply/reply/normalize-reply.d.ts
type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";
//#endregion
//#region src/auto-reply/reply/reply-dispatcher.d.ts
type ReplyDispatchErrorHandler = (err: unknown, info: {
  kind: ReplyDispatchKind;
}) => void;
type ReplyDispatchSkipHandler = (payload: ReplyPayload, info: {
  kind: ReplyDispatchKind;
  reason: NormalizeReplySkipReason;
}) => void;
type ReplyDispatchDeliverer = (payload: ReplyPayload, info: {
  kind: ReplyDispatchKind;
}) => Promise<unknown>;
type ReplyDispatchBeforeDeliver = (payload: ReplyPayload, info: {
  kind: ReplyDispatchKind;
}) => Promise<ReplyPayload | null> | ReplyPayload | null;
type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  silentReplyContext?: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
  };
  responsePrefix?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null; /** Static context for response prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => void;
  onError?: ReplyDispatchErrorHandler;
  onSkip?: ReplyDispatchSkipHandler; /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
  beforeDeliver?: ReplyDispatchBeforeDeliver;
};
type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  typingCallbacks?: TypingCallbacks;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void; /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};
type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void; /** Signal that the model run is complete so the typing controller can stop. */
  markRunComplete: () => void;
};
declare function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher;
declare function createReplyDispatcherWithTyping(options: ReplyDispatcherWithTypingOptions): ReplyDispatcherWithTypingResult;
//#endregion
//#region src/auto-reply/reply/provider-dispatcher.types.d.ts
type DispatchReplyContext = MsgContext | FinalizedMsgContext;
type DispatchReplyOptions = Omit<GetReplyOptions, "onBlockReply">;
type DispatchReplyWithBufferedBlockDispatcher = (params: {
  ctx: DispatchReplyContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: DispatchReplyOptions;
  replyResolver?: GetReplyFromConfig;
}) => Promise<DispatchFromConfigResult>;
type DispatchReplyWithDispatcher = (params: {
  ctx: DispatchReplyContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: DispatchReplyOptions;
  replyResolver?: GetReplyFromConfig;
}) => Promise<DispatchFromConfigResult>;
//#endregion
export { createReplyDispatcher as a, ReplyDispatcherWithTypingOptions as i, DispatchReplyWithDispatcher as n, createReplyDispatcherWithTyping as o, ReplyDispatcherOptions as r, DispatchReplyWithBufferedBlockDispatcher as t };