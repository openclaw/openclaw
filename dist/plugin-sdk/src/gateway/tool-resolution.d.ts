import type { AnyAgentTool } from "../agents/tools/common.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type GatewayScopedToolSurface = "http" | "loopback";
export declare function resolveGatewayScopedTools(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider?: string;
    accountId?: string;
    inboundEventKind?: InboundEventKind;
    agentTo?: string;
    agentThreadId?: string;
    senderIsOwner?: boolean;
    allowGatewaySubagentBinding?: boolean;
    allowMediaInvokeCommands?: boolean;
    surface?: GatewayScopedToolSurface;
    excludeToolNames?: Iterable<string>;
    disablePluginTools?: boolean;
    gatewayRequestedTools?: string[];
}): {
    agentId: string | undefined;
    tools: AnyAgentTool[];
};
export {};
