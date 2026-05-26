import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { y as ResolvedProviderRuntimeAuth } from "./types-core-CxmUEffr.js";
import { d as resolveApiKeyForProvider$1 } from "./model-auth-CDSCM02d.js";
import { Api, Model } from "@earendil-works/pi-ai";

//#region src/plugins/runtime/runtime-model-auth.runtime.d.ts
/**
 * Resolve request-ready auth for a runtime model, applying any provider-owned
 * `prepareRuntimeAuth` exchange on top of the standard credential lookup.
 */
declare function getRuntimeAuthForModel$1(params: {
  model: Model<Api>;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<ResolvedProviderRuntimeAuth>;
//#endregion
//#region src/agents/api-key-rotation.d.ts
type ApiKeyRetryParams = {
  apiKey: string;
  error: unknown;
  attempt: number;
};
type ExecuteWithApiKeyRotationOptions<T> = {
  provider: string;
  apiKeys: string[];
  execute: (apiKey: string) => Promise<T>;
  shouldRetry?: (params: ApiKeyRetryParams & {
    message: string;
  }) => boolean;
  onRetry?: (params: ApiKeyRetryParams & {
    message: string;
  }) => void;
};
declare function collectProviderApiKeysForExecution(params: {
  provider: string;
  primaryApiKey?: string;
}): string[];
declare function executeWithApiKeyRotation<T>(params: ExecuteWithApiKeyRotationOptions<T>): Promise<T>;
//#endregion
//#region src/plugin-sdk/provider-auth-runtime.d.ts
type OAuthCallbackResult = {
  code: string;
  state: string;
};
declare function generateOAuthState(): string;
declare function parseOAuthCallbackInput(input: string, messages?: {
  missingState?: string;
  invalidInput?: string;
}): OAuthCallbackResult | {
  error: string;
};
declare function waitForLocalOAuthCallback(params: {
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
type ResolveApiKeyForProvider = typeof resolveApiKeyForProvider$1;
type GetRuntimeAuthForModel = typeof getRuntimeAuthForModel$1;
declare function resolveApiKeyForProvider(params: Parameters<ResolveApiKeyForProvider>[0]): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>>;
declare function getRuntimeAuthForModel(params: Parameters<GetRuntimeAuthForModel>[0]): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>>;
//#endregion
export { resolveApiKeyForProvider as a, executeWithApiKeyRotation as c, parseOAuthCallbackInput as i, generateOAuthState as n, waitForLocalOAuthCallback as o, getRuntimeAuthForModel as r, collectProviderApiKeysForExecution as s, OAuthCallbackResult as t };