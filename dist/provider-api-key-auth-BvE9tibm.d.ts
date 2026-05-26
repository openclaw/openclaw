import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { St as ProviderAuthMethod, sn as ProviderPluginWizardSetup } from "./types-lCXG2pW_.js";

//#region src/plugins/provider-api-key-auth.d.ts
type ProviderApiKeyAuthMethodOptions = {
  providerId: string;
  methodId: string;
  label: string;
  hint?: string;
  wizard?: ProviderPluginWizardSetup;
  optionKey: string;
  flagName: `--${string}`;
  envVar: string;
  promptMessage: string;
  profileId?: string;
  profileIds?: string[];
  allowProfile?: boolean;
  defaultModel?: string;
  expectedProviders?: string[];
  metadata?: Record<string, string>;
  noteMessage?: string;
  noteTitle?: string;
  applyConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
};
declare function createProviderApiKeyAuthMethod(params: ProviderApiKeyAuthMethodOptions): ProviderAuthMethod;
//#endregion
export { createProviderApiKeyAuthMethod as t };