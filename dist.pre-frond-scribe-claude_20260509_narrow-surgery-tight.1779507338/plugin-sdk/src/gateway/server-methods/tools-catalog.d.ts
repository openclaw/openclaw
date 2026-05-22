import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type ToolsCatalogResult } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
export declare function buildToolsCatalogResult(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    includePlugins?: boolean;
}): ToolsCatalogResult;
export declare const toolsCatalogHandlers: GatewayRequestHandlers;
