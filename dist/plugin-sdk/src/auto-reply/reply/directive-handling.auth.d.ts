import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type ModelAuthDetailMode = "compact" | "verbose";
export declare const resolveAuthLabel: (provider: string, cfg: OpenClawConfig, modelsPath: string, agentDir?: string, mode?: ModelAuthDetailMode, workspaceDir?: string) => Promise<{
    label: string;
    source: string;
}>;
export declare const formatAuthLabel: (auth: {
    label: string;
    source: string;
}) => string;
