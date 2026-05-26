export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export { collectProviderApiKeysForExecution, executeWithApiKeyRotation, } from "../agents/api-key-rotation.js";
export { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
export { requireApiKey, resolveAwsSdkEnvVarName, type ResolvedProviderAuth, } from "../agents/model-auth-runtime-shared.js";
export type { ProviderPreparedRuntimeAuth } from "../plugins/types.js";
export type { ResolvedProviderRuntimeAuth } from "../plugins/runtime/model-auth-types.js";
export type OAuthCallbackResult = {
    code: string;
    state: string;
};
export declare function generateOAuthState(): string;
export declare function parseOAuthCallbackInput(input: string, messages?: {
    missingState?: string;
    invalidInput?: string;
}): OAuthCallbackResult | {
    error: string;
};
export declare function waitForLocalOAuthCallback(params: {
    expectedState: string;
    timeoutMs: number;
    port: number;
    callbackPath: string;
    redirectUri: string;
    successTitle: string;
    progressMessage?: string;
    hostname?: string;
    onProgress?: (message: string) => void;
}): Promise<OAuthCallbackResult>;
type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type GetRuntimeAuthForModel = typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModel;
export declare function resolveApiKeyForProvider(params: Parameters<ResolveApiKeyForProvider>[0]): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>>;
export declare function getRuntimeAuthForModel(params: Parameters<GetRuntimeAuthForModel>[0]): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>>;
