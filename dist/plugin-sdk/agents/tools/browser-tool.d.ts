import { type AnyAgentTool } from "./common.js";
export declare function createBrowserTool(opts?: {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
}): AnyAgentTool;
