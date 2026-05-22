import type { Command } from "commander";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayClientMode, GatewayClientName } from "../gateway/protocol/client-info.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
export type { GatewayRpcOpts } from "./gateway-rpc.types.js";
export declare function addGatewayClientOptions(cmd: Command): Command;
export declare function callGatewayFromCli(method: string, opts: GatewayRpcOpts, params?: unknown, extra?: {
    clientName?: GatewayClientName;
    mode?: GatewayClientMode;
    deviceIdentity?: DeviceIdentity | null;
    expectFinal?: boolean;
    progress?: boolean;
    scopes?: OperatorScope[];
}): Promise<Record<string, unknown>>;
