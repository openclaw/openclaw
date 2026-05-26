import type { IncomingMessage, ServerResponse } from "node:http";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type McpRequestContext = {
    sessionKey: string;
    messageProvider: string | undefined;
    accountId: string | undefined;
    inboundEventKind: InboundEventKind | undefined;
    senderIsOwner: boolean | undefined;
};
export declare function validateMcpLoopbackRequest(params: {
    req: IncomingMessage;
    res: ServerResponse;
    ownerToken: string;
    nonOwnerToken: string;
}): {
    senderIsOwner: boolean;
} | null;
export declare function readMcpHttpBody(req: IncomingMessage): Promise<string>;
export declare function resolveMcpRequestContext(req: IncomingMessage, cfg: OpenClawConfig, auth: {
    senderIsOwner: boolean;
}): McpRequestContext;
export {};
