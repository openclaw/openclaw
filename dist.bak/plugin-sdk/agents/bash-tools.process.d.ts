import type { AgentTool } from "@mariozechner/pi-agent-core";
export type ProcessToolDefaults = {
    cleanupMs?: number;
    scopeKey?: string;
};
export declare function createProcessTool(defaults?: ProcessToolDefaults): AgentTool<any, unknown>;
export declare const processTool: AgentTool<any, unknown>;
