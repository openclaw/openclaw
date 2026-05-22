import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutboundReplyPayload } from "./reply-payload.js";
export { createPreCryptoDirectDmAuthorizer, resolveInboundDirectDmAccessWithRuntime, type AccessGroupMembershipResolver, type DirectDmCommandAuthorizationRuntime, type ResolvedInboundDirectDmAccess, } from "./direct-dm-access.js";
export { createDirectDmPreCryptoGuardPolicy, type DirectDmPreCryptoGuardPolicy, type DirectDmPreCryptoGuardPolicyOverrides, } from "./direct-dm-guard-policy.js";
type DirectDmRoutePeer = {
    kind: "direct";
    id: string;
};
type DirectDmRoute = {
    agentId: string;
    sessionKey: string;
    accountId?: string;
};
type DirectDmRuntime = {
    channel: {
        routing: {
            resolveAgentRoute: (params: {
                cfg: OpenClawConfig;
                channel: string;
                accountId: string;
                peer: DirectDmRoutePeer;
            }) => DirectDmRoute;
        };
        session: {
            resolveStorePath: typeof import("../config/sessions.js").resolveStorePath;
            readSessionUpdatedAt: (params: {
                storePath: string;
                sessionKey: string;
            }) => number | undefined;
            recordInboundSession: typeof import("../channels/session.js").recordInboundSession;
        };
        reply: {
            resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => ReturnType<typeof import("../auto-reply/envelope.js").resolveEnvelopeFormatOptions>;
            formatAgentEnvelope: typeof import("../auto-reply/envelope.js").formatAgentEnvelope;
            finalizeInboundContext: typeof import("../auto-reply/reply/inbound-context.js").finalizeInboundContext;
            dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
        };
    };
};
/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
export declare function dispatchInboundDirectDmWithRuntime(params: {
    cfg: OpenClawConfig;
    runtime: DirectDmRuntime;
    channel: string;
    channelLabel: string;
    accountId: string;
    peer: DirectDmRoutePeer;
    senderId: string;
    senderAddress: string;
    recipientAddress: string;
    conversationLabel: string;
    rawBody: string;
    messageId: string;
    timestamp?: number;
    commandAuthorized?: boolean;
    bodyForAgent?: string;
    commandBody?: string;
    provider?: string;
    surface?: string;
    originatingChannel?: string;
    originatingTo?: string;
    extraContext?: Record<string, unknown>;
    deliver: (payload: OutboundReplyPayload) => Promise<void>;
    onRecordError: (err: unknown) => void;
    onDispatchError: (err: unknown, info: {
        kind: string;
    }) => void;
}): Promise<{
    route: DirectDmRoute;
    storePath: string;
    ctxPayload: FinalizedMsgContext;
}>;
