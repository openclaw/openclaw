import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
export type OpenClawPluginToolOptions = {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    agentDir?: string;
    workspaceDir?: string;
    config?: OpenClawConfig;
    fsPolicy?: ToolFsPolicy;
    requesterSenderId?: string | null;
    requesterAgentIdOverride?: string;
    senderIsOwner?: boolean;
    sessionId?: string;
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    sandboxed?: boolean;
    allowGatewaySubagentBinding?: boolean;
};
export declare function resolveOpenClawPluginToolInputs(params: {
    options?: OpenClawPluginToolOptions;
    resolvedConfig?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig;
    getRuntimeConfig?: () => OpenClawConfig | undefined;
}): {
    context: {
        config: OpenClawConfig | undefined;
        runtimeConfig: OpenClawConfig | undefined;
        getRuntimeConfig: (() => OpenClawConfig | undefined) | undefined;
        fsPolicy: ToolFsPolicy | undefined;
        workspaceDir: string;
        agentDir: string | undefined;
        agentId: string;
        sessionKey: string | undefined;
        sessionId: string | undefined;
        browser: {
            sandboxBridgeUrl: string | undefined;
            allowHostControl: boolean | undefined;
        };
        messageChannel: (string & {
            readonly __openclawChannelIdBrand?: never;
        }) | undefined;
        agentAccountId: string | undefined;
        deliveryContext: import("../utils/delivery-context.types.ts").DeliveryContext | undefined;
        requesterSenderId: string | undefined;
        senderIsOwner: boolean | undefined;
        sandboxed: boolean | undefined;
    };
    allowGatewaySubagentBinding: boolean | undefined;
};
