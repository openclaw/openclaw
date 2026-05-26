import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeWebFetchMetadata, RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
type WebProviderRuntimeMetadata = RuntimeWebFetchMetadata | RuntimeWebSearchMetadata;
type ResolvedWebToolRuntimeContext<TMetadata extends WebProviderRuntimeMetadata> = {
    config?: OpenClawConfig;
    preferRuntimeProviders: boolean;
    runtimeMetadata?: TMetadata;
};
export declare function resolveWebSearchToolRuntimeContext(params: {
    config?: OpenClawConfig;
    lateBindRuntimeConfig?: boolean;
    runtimeWebSearch?: RuntimeWebSearchMetadata;
}): ResolvedWebToolRuntimeContext<RuntimeWebSearchMetadata> & {
    runtimeWebSearch?: RuntimeWebSearchMetadata;
};
export declare function resolveWebFetchToolRuntimeContext(params: {
    config?: OpenClawConfig;
    lateBindRuntimeConfig?: boolean;
    runtimeWebFetch?: RuntimeWebFetchMetadata;
}): ResolvedWebToolRuntimeContext<RuntimeWebFetchMetadata> & {
    runtimeWebFetch?: RuntimeWebFetchMetadata;
};
export {};
