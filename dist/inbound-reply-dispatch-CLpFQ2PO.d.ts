import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as GetReplyOptions } from "./get-reply-options.types-DiZecFJG.js";
import { t as FinalizedMsgContext } from "./templating-DbSpLCuR.js";
import { t as OutboundReplyPayload } from "./reply-payload-BlNiejVc.js";
import { n as ReplyDispatcher } from "./reply-dispatcher.types-ZeVAzUxF.js";
import { t as DispatchFromConfigResult } from "./dispatch-from-config.types-D9GatrrF.js";
import { t as DispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher.types-sSkHKICV.js";
import { F as recordChannelBotPairLoopAndCheckSuppression, M as ChannelBotLoopProtectionFacts, O as RunChannelTurnParams, T as PreparedChannelTurn, _ as ChannelTurnResult, b as DispatchedChannelTurnResult, d as ChannelTurnDroppedHistoryOptions, m as ChannelTurnRecordOptions } from "./types-C4IQ1Uoz.js";
import { c as DurableInboundReplyDeliveryParams, r as recordDroppedChannelTurnHistory, s as DurableInboundReplyDeliveryOptions, u as deliverInboundReplyWithMessageSendContext } from "./kernel-Bim1KQTo.js";
import { a as hasVisibleChannelTurnDispatch, i as hasFinalChannelTurnDispatch, o as resolveChannelTurnDispatchCounts } from "./dispatch-result-CBhc_yqr.js";
import { t as recordInboundSession } from "./session-BmjQuM_y.js";

//#region src/plugin-sdk/inbound-reply-dispatch.d.ts
declare namespace inbound_reply_dispatch_d_exports {
  export { ChannelBotLoopProtectionFacts, ChannelTurnDroppedHistoryOptions, ChannelTurnRecordOptions, DurableInboundReplyDeliveryParams, buildChannelMessageReplyDispatchBase, buildInboundReplyDispatchBase, deliverInboundReplyWithMessageSendContext as deliverDurableInboundReplyPayload, deliverInboundReplyWithMessageSendContext, dispatchChannelMessageReplyWithBase, dispatchInboundReplyWithBase, dispatchReplyFromConfigWithSettledDispatcher, hasFinalChannelMessageReplyDispatch, hasFinalChannelTurnDispatch as hasFinalInboundReplyDispatch, hasVisibleChannelMessageReplyDispatch, hasVisibleChannelTurnDispatch as hasVisibleInboundReplyDispatch, recordChannelBotPairLoopAndCheckSuppression, recordChannelMessageReplyDispatch, recordDroppedChannelTurnHistory, recordInboundSessionAndDispatchReply, resolveChannelMessageReplyDispatchCounts, resolveChannelTurnDispatchCounts as resolveInboundReplyDispatchCounts, runInboundReplyTurn, runPreparedInboundReplyTurn };
}
type ReplyOptionsWithoutModelSelected = Omit<Omit<GetReplyOptions, "onBlockReply">, "onModelSelected">;
type RecordInboundSessionFn = typeof recordInboundSession;
type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onBlockReply">;
/** Run an already assembled channel turn through shared session-record + dispatch ordering. */
type PreparedInboundReplyTurnWithBotLoopProtection<TDispatchResult> = PreparedChannelTurn<TDispatchResult> & {
  botLoopProtection: NonNullable<PreparedChannelTurn<TDispatchResult>["botLoopProtection"]>;
};
type PreparedInboundReplyTurnWithoutBotLoopProtection<TDispatchResult> = Omit<PreparedChannelTurn<TDispatchResult>, "botLoopProtection"> & {
  botLoopProtection?: undefined;
};
declare function runPreparedInboundReplyTurn<TDispatchResult>(params: PreparedInboundReplyTurnWithBotLoopProtection<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
declare function runPreparedInboundReplyTurn<TDispatchResult>(params: PreparedInboundReplyTurnWithoutBotLoopProtection<TDispatchResult>): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
declare function runPreparedInboundReplyTurn<TDispatchResult>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
/** Run a channel turn through shared ingest, record, dispatch, and finalize ordering. */
declare function runInboundReplyTurn<TRaw, TDispatchResult = DispatchFromConfigResult>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
declare function dispatchReplyFromConfigWithSettledDispatcher(params: {
  cfg: OpenClawConfig;
  ctxPayload: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  onSettled: () => void | Promise<void>;
  replyOptions?: ReplyDispatchFromConfigOptions;
  configOverride?: OpenClawConfig;
}): Promise<DispatchFromConfigResult>;
/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
declare function buildInboundReplyDispatchBase(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  route: {
    agentId: string;
    sessionKey: string;
  };
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  core: {
    channel: {
      session: {
        recordInboundSession: RecordInboundSessionFn;
      };
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
      };
    };
  };
}): {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string | undefined;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: typeof recordInboundSession;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
};
type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordChannelMessageReplyDispatchParams = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSessionFn;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  durable?: false | DurableInboundReplyDeliveryOptions;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: {
    kind: string;
  }) => void;
  replyOptions?: ReplyOptionsWithoutModelSelected;
};
/**
 * Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
 *
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
 * sends through `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
declare function dispatchChannelMessageReplyWithBase(params: BuildInboundReplyDispatchBaseParams & Pick<RecordChannelMessageReplyDispatchParams, "deliver" | "durable" | "onRecordError" | "onDispatchError" | "replyOptions">): Promise<void>;
/**
 * Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
 *
 * @deprecated Legacy inbound reply helper. New channel plugins should expose a
 * `message` adapter via `defineChannelMessageAdapter(...)` and use
 * `dispatchChannelMessageReplyWithBase` only for compatibility dispatchers that
 * have not moved to the message lifecycle yet.
 */
declare function dispatchInboundReplyWithBase(params: Parameters<typeof dispatchChannelMessageReplyWithBase>[0]): Promise<void>;
/**
 * Record the inbound session first, then dispatch the reply using normalized outbound delivery.
 *
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
 * sends through `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
declare function recordChannelMessageReplyDispatch(params: RecordChannelMessageReplyDispatchParams): Promise<void>;
/**
 * Record the inbound session first, then dispatch the reply using normalized outbound delivery.
 *
 * @deprecated Legacy inbound reply helper. New channel plugins should expose a
 * `message` adapter via `defineChannelMessageAdapter(...)` and use
 * `recordChannelMessageReplyDispatch` only for compatibility dispatchers that
 * have not moved to the message lifecycle yet.
 */
declare function recordInboundSessionAndDispatchReply(params: RecordChannelMessageReplyDispatchParams): Promise<void>;
/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
declare const buildChannelMessageReplyDispatchBase: typeof buildInboundReplyDispatchBase;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
declare const hasFinalChannelMessageReplyDispatch: typeof hasFinalChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
declare const hasVisibleChannelMessageReplyDispatch: typeof hasVisibleChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
declare const resolveChannelMessageReplyDispatchCounts: typeof resolveChannelTurnDispatchCounts;
//#endregion
export { dispatchReplyFromConfigWithSettledDispatcher as a, inbound_reply_dispatch_d_exports as c, resolveChannelMessageReplyDispatchCounts as d, runInboundReplyTurn as f, dispatchInboundReplyWithBase as i, recordChannelMessageReplyDispatch as l, buildInboundReplyDispatchBase as n, hasFinalChannelMessageReplyDispatch as o, runPreparedInboundReplyTurn as p, dispatchChannelMessageReplyWithBase as r, hasVisibleChannelMessageReplyDispatch as s, buildChannelMessageReplyDispatchBase as t, recordInboundSessionAndDispatchReply as u };