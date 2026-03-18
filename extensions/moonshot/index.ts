import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "openclaw/plugin-sdk/provider-stream";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildMoonshotProvider } from "./provider-catalog.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Moonshot",
      docsPath: "/providers/moonshot",
      envVars: ["MOONSHOT_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Kimi API key (.ai)",
          hint: "Kimi K2.5 + Kimi",
          optionKey: "moonshotApiKey",
          flagName: "--moonshot-api-key",
          envVar: "MOONSHOT_API_KEY",
          promptMessage: "Enter Moonshot API key",
          defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
          expectedProviders: ["moonshot"],
          applyConfig: (cfg) => applyMoonshotConfig(cfg),
          wizard: {
            choiceId: "moonshot-api-key",
            choiceLabel: "Kimi API key (.ai)",
            groupId: "moonshot",
            groupLabel: "Moonshot AI (Kimi K2.5)",
            groupHint: "Kimi K2.5 + Kimi",
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key-cn",
          label: "Kimi API key (.cn)",
          hint: "Kimi K2.5 + Kimi",
          optionKey: "moonshotApiKey",
          flagName: "--moonshot-api-key",
          envVar: "MOONSHOT_API_KEY",
          promptMessage: "Enter Moonshot API key (.cn)",
          defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
          expectedProviders: ["moonshot"],
          applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
          wizard: {
            choiceId: "moonshot-api-key-cn",
            choiceLabel: "Kimi API key (.cn)",
            groupId: "moonshot",
            groupLabel: "Moonshot AI (Kimi K2.5)",
            groupHint: "Kimi K2.5 + Kimi",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildMoonshotProvider,
            allowExplicitBaseUrl: true,
          }),
      },
      wrapStreamFn: (ctx) => {
        const thinkingType = resolveMoonshotThinkingType({
          configuredThinking: ctx.extraParams?.thinking,
          thinkingLevel: ctx.thinkingLevel,
        });
        return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType);
      },
    });
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
