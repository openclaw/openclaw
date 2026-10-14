import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { applyFalConfig } from "./onboard.js";
import {
  createFalProvider as createFalProviderContract,
  createFalAuthMethodMetadata,
} from "./provider-contract-api.js";

const PROVIDER_ID = "fal";

export function createFalProvider(): ProviderPlugin {
  return {
    ...createFalProviderContract(),
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key",
        ...createFalAuthMethodMetadata(),
        optionKey: "falApiKey",
        flagName: "--fal-api-key",
        envVar: "FAL_KEY",
        promptMessage: "Enter fal API key",
        expectedProviders: ["fal"],
        applyConfig: (cfg) => applyFalConfig(cfg),
      }),
    ],
  };
}
