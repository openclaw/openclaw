import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
//#region extensions/anthropic/config-defaults.d.ts
declare function normalizeAnthropicProviderConfigForProvider<T extends {
  api?: string;
  models?: unknown[];
}>(params: {
  provider: string;
  providerConfig: T;
}): T;
declare function applyAnthropicConfigDefaults(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): OpenClawConfig;
//#endregion
export { normalizeAnthropicProviderConfigForProvider as n, applyAnthropicConfigDefaults as t };