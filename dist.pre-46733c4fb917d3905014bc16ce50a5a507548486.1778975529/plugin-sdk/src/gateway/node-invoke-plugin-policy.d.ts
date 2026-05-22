import type { OpenClawPluginNodeInvokePolicyResult } from "../plugins/types.js";
import type { NodeSession } from "./node-registry.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
export declare function applyPluginNodeInvokePolicy(params: {
    context: GatewayRequestContext;
    client: GatewayClient | null;
    nodeSession: NodeSession;
    command: string;
    params: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null>;
