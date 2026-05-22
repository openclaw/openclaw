import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function ensureRuntimePluginsLoaded(params: {
    config?: OpenClawConfig;
    workspaceDir?: string | null;
    allowGatewaySubagentBinding?: boolean;
}): void;
