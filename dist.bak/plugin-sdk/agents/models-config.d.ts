import { type OpenClawConfig } from "../config/config.js";
export declare function ensureOpenClawModelsJson(config?: OpenClawConfig, agentDirOverride?: string): Promise<{
    agentDir: string;
    wrote: boolean;
}>;
