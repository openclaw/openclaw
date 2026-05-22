import type { Api, Model } from "@mariozechner/pi-ai";
import { getApiKeyForModel as resolveModelApiKey, resolveApiKeyForProvider as resolveProviderApiKey } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ResolvedProviderRuntimeAuth } from "./model-auth-types.js";
export declare function getApiKeyForModel(params: Parameters<typeof resolveModelApiKey>[0]): Promise<Awaited<ReturnType<typeof resolveModelApiKey>>>;
export declare function resolveApiKeyForProvider(params: Parameters<typeof resolveProviderApiKey>[0]): Promise<Awaited<ReturnType<typeof resolveProviderApiKey>>>;
/**
 * Resolve request-ready auth for a runtime model, applying any provider-owned
 * `prepareRuntimeAuth` exchange on top of the standard credential lookup.
 */
export declare function getRuntimeAuthForModel(params: {
    model: Model<Api>;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
}): Promise<ResolvedProviderRuntimeAuth>;
