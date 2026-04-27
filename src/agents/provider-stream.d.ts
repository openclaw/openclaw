import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function registerProviderStreamForModel<TApi extends Api>(params: {
    model: Model<TApi>;
    cfg?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): StreamFn | undefined;
