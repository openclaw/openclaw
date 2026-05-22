import type { OpenClawConfig } from "../config/types.openclaw.js";
export type SubagentSpawnOwnership = {
    controllerSessionKey: string;
    threadBindingRequesterSessionKey: string;
    completionRequesterSessionKey: string;
    completionRequesterDisplayKey: string;
};
export declare function resolveSubagentSpawnOwnership(params: {
    cfg: OpenClawConfig;
    agentSessionKey?: string;
    completionOwnerKey?: string;
}): SubagentSpawnOwnership;
