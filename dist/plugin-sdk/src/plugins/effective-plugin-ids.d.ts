import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveEffectivePluginIds(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    bundledPluginsDir?: string;
}): string[];
