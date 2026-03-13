import type { OpenClawConfig } from "../config/config.js";
export type ModelsJsonPlan = {
    action: "skip";
} | {
    action: "noop";
} | {
    action: "write";
    contents: string;
};
export declare function planOpenClawModelsJson(params: {
    cfg: OpenClawConfig;
    sourceConfigForSecrets?: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    existingRaw: string;
    existingParsed: unknown;
}): Promise<ModelsJsonPlan>;
