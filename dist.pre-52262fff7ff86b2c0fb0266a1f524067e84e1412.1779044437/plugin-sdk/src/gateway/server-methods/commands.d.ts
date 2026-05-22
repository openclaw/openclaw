import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CommandsListResult } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
export declare function buildCommandsListResult(params: {
    cfg: OpenClawConfig;
    agentId: string;
    provider?: string;
    scope?: "native" | "text" | "both";
    includeArgs?: boolean;
}): CommandsListResult;
export declare const commandsHandlers: GatewayRequestHandlers;
