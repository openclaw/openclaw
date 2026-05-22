import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { type DispatchFromConfigResult } from "../auto-reply/reply/dispatch-from-config.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { hasFinalChannelTurnDispatch, hasVisibleChannelTurnDispatch, resolveChannelTurnDispatchCounts } from "../channels/turn/kernel.js";
import type { PreparedChannelTurn, RunChannelTurnParams } from "../channels/turn/types.js";
export type { ChannelTurnRecordOptions } from "../channels/turn/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type OutboundReplyPayload } from "./reply-payload.js";
type ReplyOptionsWithoutModelSelected = Omit<Omit<GetReplyOptions, "onBlockReply">, "onModelSelected">;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;
type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onBlockReply">;
/** Run an already assembled channel turn through shared session-record + dispatch ordering. */
export declare function runPreparedInboundReplyTurn<TDispatchResult>(params: PreparedChannelTurn<TDispatchResult>): Promise<import("../channels/turn/types.js").DispatchedChannelTurnResult<TDispatchResult>>;
/** Run a channel turn through shared ingest, record, dispatch, and finalize ordering. */
export declare function runInboundReplyTurn<TRaw, TDispatchResult = DispatchFromConfigResult>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<import("../channels/turn/types.js").ChannelTurnResult<TDispatchResult>>;
export { hasFinalChannelTurnDispatch as hasFinalInboundReplyDispatch, hasVisibleChannelTurnDispatch as hasVisibleInboundReplyDispatch, resolveChannelTurnDispatchCounts as resolveInboundReplyDispatchCounts, };
/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
export declare function dispatchReplyFromConfigWithSettledDispatcher(params: {
    cfg: OpenClawConfig;
    ctxPayload: FinalizedMsgContext;
    dispatcher: ReplyDispatcher;
    onSettled: () => void | Promise<void>;
    replyOptions?: ReplyDispatchFromConfigOptions;
    configOverride?: OpenClawConfig;
}): Promise<DispatchFromConfigResult>;
/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
export declare function buildInboundReplyDispatchBase(params: {
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
    recordInboundSession: typeof import("../channels/session.js").recordInboundSession;
    dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
};
type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordInboundSessionAndDispatchReplyParams = Parameters<typeof recordInboundSessionAndDispatchReply>[0];
/** Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn. */
export declare function dispatchInboundReplyWithBase(params: BuildInboundReplyDispatchBaseParams & Pick<RecordInboundSessionAndDispatchReplyParams, "deliver" | "onRecordError" | "onDispatchError" | "replyOptions">): Promise<void>;
/** Record the inbound session first, then dispatch the reply using normalized outbound delivery. */
export declare function recordInboundSessionAndDispatchReply(params: {
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
    onRecordError: (err: unknown) => void;
    onDispatchError: (err: unknown, info: {
        kind: string;
    }) => void;
    replyOptions?: ReplyOptionsWithoutModelSelected;
}): Promise<void>;
