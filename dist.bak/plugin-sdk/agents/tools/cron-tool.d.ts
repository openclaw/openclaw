import { type AnyAgentTool } from "./common.js";
import { callGatewayTool } from "./gateway.js";
type CronToolOptions = {
    agentSessionKey?: string;
};
type GatewayToolCaller = typeof callGatewayTool;
type CronToolDeps = {
    callGatewayTool?: GatewayToolCaller;
};
export declare function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool;
export {};
