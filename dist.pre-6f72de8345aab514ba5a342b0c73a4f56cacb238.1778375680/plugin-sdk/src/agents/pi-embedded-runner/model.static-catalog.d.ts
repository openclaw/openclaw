import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveBundledStaticCatalogModel(params: {
    provider: string;
    modelId: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): Model<Api> | undefined;
