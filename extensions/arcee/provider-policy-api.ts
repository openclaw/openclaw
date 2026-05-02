import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { normalizeArceeProviderConfig } from "./provider-policy.js";

export { normalizeArceeProviderConfig };

export function normalizeConfig(params: {
  provider?: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return normalizeArceeProviderConfig(params.providerConfig);
}
