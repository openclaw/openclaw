import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfig,
} from "./config-defaults.js";

export function normalizeConfig(params: {
  provider: string;
  providerConfig: Parameters<typeof normalizeAnthropicProviderConfig>[0];
}) {
  return normalizeAnthropicProviderConfig(params.providerConfig);
}

export function applyConfigDefaults(params: Parameters<typeof applyAnthropicConfigDefaults>[0]) {
  return applyAnthropicConfigDefaults(params);
}
