import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type McpLoopbackTool, type McpToolSchemaEntry } from "./mcp-http.schema.js";
type CachedScopedTools = {
    agentId: string | undefined;
    tools: McpLoopbackTool[];
    toolSchema: McpToolSchemaEntry[];
    configRef: OpenClawConfig;
    time: number;
};
export declare function resolveMcpLoopbackScopedTools(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider: string | undefined;
    accountId: string | undefined;
    inboundEventKind: InboundEventKind | undefined;
    senderIsOwner: boolean | undefined;
}): {
    agentId: string | undefined;
    tools: McpLoopbackTool[];
};
export declare class McpLoopbackToolCache {
    #private;
    resolve(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        messageProvider: string | undefined;
        accountId: string | undefined;
        inboundEventKind: InboundEventKind | undefined;
        senderIsOwner: boolean | undefined;
    }): CachedScopedTools;
}
export {};
