import type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";
import type { AnyAgentTool } from "./common.js";
export type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";
export type ContinueWorkToolOpts = {
    agentSessionKey?: string;
    requestContinuation: (request: ContinueWorkRequest) => void;
};
export declare function createContinueWorkTool(opts: ContinueWorkToolOpts): AnyAgentTool;
