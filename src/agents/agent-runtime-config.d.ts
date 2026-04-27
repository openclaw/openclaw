import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
export declare function resolveAgentRuntimeConfig(runtime: RuntimeEnv, params?: {
    runtimeTargetsChannelSecrets?: boolean;
}): Promise<{
    loadedRaw: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    cfg: OpenClawConfig;
}>;
