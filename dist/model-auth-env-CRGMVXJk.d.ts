import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { t as ProviderAuthEvidence } from "./provider-env-vars-Dh_vzkBY.js";

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
};
declare function resolveEnvApiKey(provider: string, env?: NodeJS.ProcessEnv, options?: EnvApiKeyLookupOptions): EnvApiKeyResult | null;
//#endregion
export { resolveEnvApiKey as n, EnvApiKeyResult as t };