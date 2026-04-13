import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import { applyLitellmConfig, LITELLM_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildLitellmProvider } from "./provider-catalog.js";
import { configureLitellmNonInteractive } from "./src/setup.js";

const PROVIDER_ID = "litellm";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "LiteLLM Provider",
  description: "Bundled LiteLLM provider plugin",
  register(api: OpenClawPluginApi) {
    const baseAuthMethod = createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "api-key",
      label: "LiteLLM API key",
      hint: "Unified gateway for 100+ LLM providers",
      optionKey: "litellmApiKey",
      flagName: "--litellm-api-key",
      envVar: "LITELLM_API_KEY",
      promptMessage: "Enter LiteLLM API key",
      defaultModel: LITELLM_DEFAULT_MODEL_REF,
      applyConfig: (cfg) => applyLitellmConfig(cfg),
      noteTitle: "LiteLLM",
      noteMessage: [
        "LiteLLM provides a unified API to 100+ LLM providers.",
        "Get your API key from your LiteLLM proxy or https://litellm.ai",
        "Default proxy runs on http://localhost:4000",
      ].join("\n"),
      wizard: {
        choiceId: `${PROVIDER_ID}-api-key`,
        choiceLabel: "LiteLLM API key",
        groupId: PROVIDER_ID,
        groupLabel: "LiteLLM",
        groupHint: "Unified LLM gateway (100+ providers)",
        methodId: "api-key",
      },
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "LiteLLM",
      docsPath: "/providers/litellm",
      envVars: ["LITELLM_API_KEY"],
      auth: [
        {
          ...baseAuthMethod,
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            return await configureLitellmNonInteractive(ctx);
          },
        },
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildLitellmProvider,
            allowExplicitBaseUrl: true,
          }),
      },
    });
  },
});
