import type { IncomingMessage } from "node:http";
export { authorizeGatewayHttpRequestOrReply, authorizeScopedGatewayHttpRequestOrReply, checkGatewayHttpRequestAuth, getBearerToken, getHeader, isGatewayBearerHttpRequest, resolveHttpBrowserOriginPolicy, resolveHttpSenderIsOwner, resolveOpenAiCompatibleHttpOperatorScopes, resolveOpenAiCompatibleHttpSenderIsOwner, resolveTrustedHttpOperatorScopes, type AuthorizedGatewayHttpRequest, type GatewayHttpRequestAuthCheckResult, } from "./http-auth-utils.js";
export declare const OPENCLAW_MODEL_ID = "openclaw";
export declare const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";
export declare function resolveAgentIdFromModel(model: string | undefined, cfg?: import("openclaw/plugin-sdk").OpenClawConfig): string | undefined;
export declare function resolveOpenAiCompatModelOverride(params: {
    req: IncomingMessage;
    agentId: string;
    model: string | undefined;
}): Promise<{
    modelOverride?: string;
    errorMessage?: string;
}>;
export declare function resolveAgentIdForRequest(params: {
    req: IncomingMessage;
    model: string | undefined;
}): string;
export declare function resolveGatewayRequestContext(params: {
    req: IncomingMessage;
    model: string | undefined;
    user?: string | undefined;
    sessionPrefix: string;
    defaultMessageChannel: string;
    useMessageChannelHeader?: boolean;
}): {
    agentId: string;
    sessionKey: string;
    messageChannel: string;
};
