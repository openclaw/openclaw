import { callGateway } from "../gateway/call.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
type CallGatewayFromCliRuntimeExtra = {
    clientName?: Parameters<typeof callGateway>[0]["clientName"];
    mode?: Parameters<typeof callGateway>[0]["mode"];
    deviceIdentity?: Parameters<typeof callGateway>[0]["deviceIdentity"];
    expectFinal?: boolean;
    progress?: boolean;
    scopes?: Parameters<typeof callGateway>[0]["scopes"];
};
export declare function callGatewayFromCliRuntime(method: string, opts: GatewayRpcOpts, params?: unknown, extra?: CallGatewayFromCliRuntimeExtra): Promise<Record<string, unknown>>;
export {};
