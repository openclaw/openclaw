import { c as ensureGlobalUndiciEnvProxyDispatcher } from "../../wsl-DGjWf35r.js";
import { getOAuthApiKey as getOAuthApiKey$1, refreshOpenAICodexToken as refreshOpenAICodexToken$1 } from "@earendil-works/pi-ai/oauth";

//#region extensions/openai/openai-codex-provider.runtime.d.ts
type OpenAICodexProviderRuntimeDeps = {
  ensureGlobalUndiciEnvProxyDispatcher: typeof ensureGlobalUndiciEnvProxyDispatcher;
  getOAuthApiKey: typeof getOAuthApiKey$1;
  refreshOpenAICodexToken: typeof refreshOpenAICodexToken$1;
};
declare function createOpenAICodexProviderRuntime(deps: OpenAICodexProviderRuntimeDeps): {
  getOAuthApiKey: typeof getOAuthApiKey;
  refreshOpenAICodexToken: typeof refreshOpenAICodexToken;
};
declare function getOAuthApiKey(...args: Parameters<typeof getOAuthApiKey$1>): Promise<Awaited<ReturnType<typeof getOAuthApiKey$1>>>;
declare function refreshOpenAICodexToken(...args: Parameters<typeof refreshOpenAICodexToken$1>): Promise<Awaited<ReturnType<typeof refreshOpenAICodexToken$1>>>;
//#endregion
export { createOpenAICodexProviderRuntime, getOAuthApiKey, refreshOpenAICodexToken };