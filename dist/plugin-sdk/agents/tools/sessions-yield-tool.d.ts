import type { AnyAgentTool } from "./common.js";
export declare function createSessionsYieldTool(opts?: {
    sessionId?: string;
    onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool;
