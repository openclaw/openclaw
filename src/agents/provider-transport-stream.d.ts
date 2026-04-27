import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type ProviderTransportStreamContext = {
    cfg?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
};
export declare function isTransportAwareApiSupported(api: Api): boolean;
export declare function resolveTransportAwareSimpleApi(api: Api): Api | undefined;
export declare function createTransportAwareStreamFnForModel(model: Model<Api>, ctx?: ProviderTransportStreamContext): StreamFn | undefined;
export declare function createBoundaryAwareStreamFnForModel(model: Model<Api>, ctx?: ProviderTransportStreamContext): StreamFn | undefined;
export declare function prepareTransportAwareSimpleModel<TApi extends Api>(model: Model<TApi>, ctx?: ProviderTransportStreamContext): Model<Api>;
export declare function buildTransportAwareSimpleStreamFn(model: Model<Api>, ctx?: ProviderTransportStreamContext): StreamFn | undefined;
export {};
