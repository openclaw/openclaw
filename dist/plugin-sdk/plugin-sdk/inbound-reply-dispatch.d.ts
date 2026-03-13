import { type DispatchFromConfigResult } from "../auto-reply/reply/dispatch-from-config.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { type OutboundReplyPayload } from "./reply-payload.js";
type ReplyOptionsWithoutModelSelected = Omit<Omit<GetReplyOptions, "onToolResult" | "onBlockReply">, "onModelSelected">;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;
type DispatchReplyWithBufferedBlockDispatcherFn = typeof import("../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
export declare function dispatchReplyFromConfigWithSettledDispatcher(params: {
    cfg: OpenClawConfig;
    ctxPayload: FinalizedMsgContext;
    dispatcher: ReplyDispatcher;
    onSettled: () => void | Promise<void>;
    replyOptions?: ReplyDispatchFromConfigOptions;
}): Promise<DispatchFromConfigResult>;
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
                dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcherFn;
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
    dispatchReplyWithBufferedBlockDispatcher: typeof import("../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
};
type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordInboundSessionAndDispatchReplyParams = Parameters<typeof recordInboundSessionAndDispatchReply>[0];
export declare function dispatchInboundReplyWithBase(params: BuildInboundReplyDispatchBaseParams & Pick<RecordInboundSessionAndDispatchReplyParams, "deliver" | "onRecordError" | "onDispatchError" | "replyOptions">): Promise<void>;
export declare function recordInboundSessionAndDispatchReply(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string;
    agentId: string;
    routeSessionKey: string;
    storePath: string;
    ctxPayload: FinalizedMsgContext;
    recordInboundSession: RecordInboundSessionFn;
    dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcherFn;
    deliver: (payload: OutboundReplyPayload) => Promise<void>;
    onRecordError: (err: unknown) => void;
    onDispatchError: (err: unknown, info: {
        kind: string;
    }) => void;
    replyOptions?: ReplyOptionsWithoutModelSelected;
}): Promise<void>;
export {};
