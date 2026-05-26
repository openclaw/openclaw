import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ProviderAuthEvidence } from "./provider-env-vars-Bx_CzVCR.js";

//#region src/agents/model-auth-env.d.ts
type EnvApiKeyResult = {
  apiKey: string;
  source: string;
};
type EnvApiKeyLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  aliasMap?: Readonly<Record<string, string>>;
  candidateMap?: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap?: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
  skipSetupProviderFallback?: boolean;
};
declare function resolveEnvApiKey(provider: string, env?: NodeJS.ProcessEnv, options?: EnvApiKeyLookupOptions): EnvApiKeyResult | null;
//#endregion
export { EnvApiKeyResult as n, resolveEnvApiKey as r, EnvApiKeyLookupOptions as t };